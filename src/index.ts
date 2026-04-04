import { Elysia, t } from "elysia";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  arcTestnet,
  sepolia,
  baseSepolia,
  arbitrumSepolia,
  optimismSepolia,
  avalancheFuji,
  polygonAmoy,
} from "viem/chains";
import { abi as EVVM_ABI } from "../constant/Core.json";
import { abi as CCTP_ABI } from "../constant/CctpService.json";
import { abi as TREASURY_ABI } from "../constant/Treasury.json";

const EVVM_CONTRACT    = "0x085FEa487ca750479fB82b690C563312FBc2d1a8" as const;
const CCTP_CONTRACT    = "0x166b4207da35740e38e55B09819fdFAdF27401cD" as const;
const TREASURY_CONTRACT = "0x1fa4Ae804E27896C45771B7D41330feBC868A7Bc" as const;

// All testnet chains share the same CCTP contract addresses
const ARC_TOKEN_MESSENGER   = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as const;
const DEST_MSG_TRANSMITTER  = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" as const;
const ARC_CCTP_DOMAIN       = 26;

type ChainConfig = { viemChain: Chain; cctpDomain: number };

const CHAIN_CONFIGS: Record<string, ChainConfig> = {
  ethereum_sepolia: { viemChain: sepolia,          cctpDomain: 0 },
  avalanche_fuji:   { viemChain: avalancheFuji,    cctpDomain: 1 },
  optimism_sepolia: { viemChain: optimismSepolia,  cctpDomain: 2 },
  arbitrum_sepolia: { viemChain: arbitrumSepolia,  cctpDomain: 3 },
  base_sepolia:     { viemChain: baseSepolia,      cctpDomain: 6 },
  polygon_amoy:     { viemChain: polygonAmoy,      cctpDomain: 7 },
};

interface AttestationMessage { message: string; attestation: string; status: string; }

async function retrieveAttestation(burnTxHash: string): Promise<AttestationMessage> {
  const url = `https://iris-api-sandbox.circle.com/v2/messages/${ARC_CCTP_DOMAIN}?transactionHash=${burnTxHash}`;
  while (true) {
    const response = await fetch(url).catch(() => null);
    if (response?.ok) {
      const data = (await response.json()) as { messages: AttestationMessage[] };
      if (data?.messages?.[0]?.status === "complete") return data.messages[0];
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

if (!process.env.PRIVATE_KEY) {
  throw new Error("PRIVATE_KEY environment variable is required");
}

const account = privateKeyToAccount(
  process.env.PRIVATE_KEY as `0x${string}`
);

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(),
});

const walletClient = createWalletClient({
  account,
  chain: arcTestnet,
  transport: http(),
});

const app = new Elysia()
  .get("/", () => "Hello Elysia")
  .post(
    "/sendToEvvm",
    async ({ body }) => {
      let request;
      try {
        ({ request } = await publicClient.simulateContract({
          account,
          address: EVVM_CONTRACT,
          abi: EVVM_ABI,
          functionName: "pay",
          args: [
            body.from as `0x${string}`,
            body.to as `0x${string}`,
            body.identity,
            body.token as `0x${string}`,
            BigInt(body.amount),
            BigInt(body.priorityFee),
            body.executor as `0x${string}`,
            body.addr7 as `0x${string}`,
            BigInt(body.nonce),
            body.isAsyncExec,
            body.signature as `0x${string}`,
          ],
        }));
      } catch (err: any) {
        const reason =
          err?.cause?.data?.errorName ??
          err?.cause?.reason ??
          err?.shortMessage ??
          err?.message ??
          "simulation reverted";
        return { status: "reverted on simulation", reason };
      }

      const txHash = await walletClient.writeContract(request);

      return { status: "done", txHash };
    },
    {
      body: t.Object({
        to: t.String(),
        from: t.String(),
        identity: t.String(),
        token: t.String(),
        amount: t.String(),
        priorityFee: t.String(),
        executor: t.String(),
        addr7: t.String(),
        nonce: t.String(),
        isAsyncExec: t.Boolean(),
        signature: t.String(),
      }),
    }
  )
  .post(
    "/executeCrosschain",
    async ({ body }) => {
      let request;
      try {
        ({ request } = await publicClient.simulateContract({
          account,
          address: CCTP_CONTRACT,
          abi: CCTP_ABI,
          functionName: "executeCrosschain",
          args: [
            body.user as `0x${string}`,
            body.destinationChain,
            BigInt(body.amount),
            BigInt(body.nonce),
            body.isAsyncExec,
            body.signature as `0x${string}`,
            BigInt(body.priorityFeeEvvm),
            BigInt(body.nonceEvvm),
            body.isAsyncExecEvvm,
            body.signatureEvvm as `0x${string}`,
          ],
        }));
      } catch (err: any) {
        const reason =
          err?.cause?.data?.errorName ??
          err?.cause?.reason ??
          err?.shortMessage ??
          err?.message ??
          "simulation reverted";
        return { status: "reverted on simulation", reason };
      }

      const txHash = await walletClient.writeContract(request);

      // Withdraw the same amount from Treasury using the native coin address
      const nativeCoinAddress = await publicClient.readContract({
        address: EVVM_CONTRACT,
        abi: EVVM_ABI,
        functionName: "getChainHostCoinAddress",
      });

      let withdrawRequest;
      try {
        ({ request: withdrawRequest } = await publicClient.simulateContract({
          account,
          address: TREASURY_CONTRACT,
          abi: TREASURY_ABI,
          functionName: "withdraw",
          args: [nativeCoinAddress as `0x${string}`, BigInt(body.amount)],
        }));
      } catch (err: any) {
        const reason =
          err?.cause?.data?.errorName ??
          err?.cause?.reason ??
          err?.shortMessage ??
          err?.message ??
          "simulation reverted";
        return { status: "reverted on withdrawal simulation", reason, txHash };
      }

      const withdrawTxHash = await walletClient.writeContract(withdrawRequest);

      // ── CCTP Bridge: Arc → destinationChain ──────────────────────────────

      const destConfig = CHAIN_CONFIGS[body.destinationChain];
      if (!destConfig) {
        return {
          status: "error",
          reason: `Unsupported destinationChain: "${body.destinationChain}". Supported: ${Object.keys(CHAIN_CONFIGS).join(", ")}`,
          txHash,
          withdrawTxHash,
        };
      }

      // Get Arc USDC address from CctpService
      const arcUsdcAddress = (await publicClient.readContract({
        address: CCTP_CONTRACT,
        abi: CCTP_ABI,
        functionName: "getPrincipalTokenAddress",
      })) as `0x${string}`;

      const mintRecipientBytes32 = `0x000000000000000000000000${body.user.slice(2)}` as `0x${string}`;
      const amount = BigInt(body.amount);

      // Approve TokenMessengerV2 to spend Arc USDC
      const approveTxHash = await walletClient.sendTransaction({
        to: arcUsdcAddress,
        data: encodeFunctionData({
          abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }],
          functionName: "approve",
          args: [ARC_TOKEN_MESSENGER, amount],
        }),
      });

      // Burn USDC on Arc via TokenMessengerV2
      const burnTxHash = await walletClient.sendTransaction({
        to: ARC_TOKEN_MESSENGER,
        data: encodeFunctionData({
          abi: [{ type: "function", name: "depositForBurn", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }, { name: "destinationDomain", type: "uint32" }, { name: "mintRecipient", type: "bytes32" }, { name: "burnToken", type: "address" }, { name: "destinationCaller", type: "bytes32" }, { name: "maxFee", type: "uint256" }, { name: "minFinalityThreshold", type: "uint32" }], outputs: [] }],
          functionName: "depositForBurn",
          args: [
            amount,
            destConfig.cctpDomain,
            mintRecipientBytes32,
            arcUsdcAddress,
            "0x0000000000000000000000000000000000000000000000000000000000000000",
            amount / 2000n > 500n ? amount / 2000n : 500n,
            1000,
          ],
        }),
      });

      // Wait for Circle attestation
      const attestation = await retrieveAttestation(burnTxHash);

      // Mint USDC on destination chain
      const destWalletClient = createWalletClient({
        account,
        chain: destConfig.viemChain,
        transport: http(),
      });

      const mintTxHash = await destWalletClient.sendTransaction({
        to: DEST_MSG_TRANSMITTER,
        data: encodeFunctionData({
          abi: [{ type: "function", name: "receiveMessage", stateMutability: "nonpayable", inputs: [{ name: "message", type: "bytes" }, { name: "attestation", type: "bytes" }], outputs: [] }],
          functionName: "receiveMessage",
          args: [attestation.message as `0x${string}`, attestation.attestation as `0x${string}`],
        }),
      });

      return { status: "done", txHash, withdrawTxHash, approveTxHash, burnTxHash, mintTxHash };
    },
    {
      body: t.Object({
        user: t.String(),
        destinationChain: t.String(),
        amount: t.String(),
        nonce: t.String(),
        isAsyncExec: t.Boolean(),
        signature: t.String(),
        priorityFeeEvvm: t.String(),
        nonceEvvm: t.String(),
        isAsyncExecEvvm: t.Boolean(),
        signatureEvvm: t.String(),
      }),
    }
  )
  .listen(3001);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
