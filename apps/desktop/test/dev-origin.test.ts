import { describe, expect, it } from "vitest";
import { devRequestHeaders, devResponseHeaders } from "../electron/dev-origin.ts";

const DEV = "http://127.0.0.1:5299";
const APP = "app://pinomad";

describe("devRequestHeaders", () => {
  it("presents the dev renderer's requests as the desktop origin", () => {
    expect(devRequestHeaders({ Origin: DEV, Accept: "*/*" }, DEV, APP)).toEqual({ Origin: APP, Accept: "*/*" });
    expect(devRequestHeaders({ origin: DEV }, DEV, APP)).toEqual({ origin: APP });
  });

  it("leaves other origins and Origin-less requests alone", () => {
    expect(devRequestHeaders({ Origin: "https://evil.example" }, DEV, APP)).toBeUndefined();
    expect(devRequestHeaders({ Accept: "*/*" }, DEV, APP)).toBeUndefined();
  });
});

describe("devResponseHeaders", () => {
  it("hands the desktop origin's CORS grant back to the dev renderer", () => {
    expect(
      devResponseHeaders({ "Access-Control-Allow-Origin": [APP], Vary: ["Origin"] }, DEV, APP),
    ).toEqual({ "Access-Control-Allow-Origin": [DEV], Vary: ["Origin"] });
    expect(devResponseHeaders({ "access-control-allow-origin": [APP] }, DEV, APP)).toEqual({
      "access-control-allow-origin": [DEV],
    });
  });

  it("does not widen a grant made to anyone else", () => {
    expect(devResponseHeaders({ "access-control-allow-origin": ["*"] }, DEV, APP)).toBeUndefined();
    expect(devResponseHeaders({ "access-control-allow-origin": ["https://other"] }, DEV, APP)).toBeUndefined();
    expect(devResponseHeaders({ "content-type": ["text/html"] }, DEV, APP)).toBeUndefined();
  });
});
