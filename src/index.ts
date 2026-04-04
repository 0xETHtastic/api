import { Elysia, t } from "elysia";

const app = new Elysia()
  .get("/", () => "Hello Elysia")
  .post(
    "/sendToEvvm",
    ({ body }) => ({ responseStatus: "done", ...body }),
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
