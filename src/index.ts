import { Elysia, t } from "elysia";
import {
  createPublicClient,
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import { abi as EVVM_ABI } from "../constant/Core.json";

const EVVM_CONTRACT = "0x085FEa487ca750479fB82b690C563312FBc2d1a8" as const;

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
  .listen(3001);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);
