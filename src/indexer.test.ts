import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";

// Smoke test: constructing the test indexer loads and registers ALL handler files.
// A runtime import error or duplicate event registration would throw here.
describe("indexer wiring", () => {
  it("loads all handlers and registers a simple admin event", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        1: {
          simulate: [
            {
              contract: "DolomiteMargin",
              event: "LogSetGlobalOperator",
              params: {
                operator: "0x1111111111111111111111111111111111111111",
                approved: true,
              },
            },
          ],
        },
      },
    });

    const op = await indexer.GlobalOperator.getOrThrow(
      "1-0x1111111111111111111111111111111111111111"
    );
    expect(op.id).toEqual("1-0x1111111111111111111111111111111111111111");
  });
});
