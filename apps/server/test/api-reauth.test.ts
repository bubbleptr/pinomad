// A signed-in route that reads a body must act on the session as it stands
// once the body has arrived, not as it stood at the headers (CWE-367): the
// caller can hold the body back while the session is revoked elsewhere.
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import * as ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { addUser, openAccounts, type Accounts } from "../src/accounts.ts";
import { startRelay, type Relay } from "../src/relay.ts";
import { removeTempDir, tempDir } from "./support.ts";

const ORIGIN = "https://relay.example.com";
const GOOD_PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a brand new passphrase";
const APNS = "cc".repeat(32);
const HOST_ID = "h".repeat(43);

const dirs: string[] = [];
const relays: Relay[] = [];
afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

interface Started {
  readonly relay: Relay;
  readonly accounts: Accounts;
  readonly dataDir: string;
  /** Resolves once the API has authenticated `token`, i.e. the handler is now waiting on the body. */
  readonly authenticated: (token: string) => Promise<void>;
}

async function startServer(): Promise<Started> {
  const dataDir = await tempDir(dirs);
  const accounts = await openAccounts({ dataDir, bootstrapUser: "admin", bootstrapPassword: GOOD_PASSWORD });
  const waiting = new Map<string, () => void>();
  const watched: Accounts = {
    ...accounts,
    authenticate(token) {
      const result = accounts.authenticate(token);
      waiting.get(token)?.();
      waiting.delete(token);
      return result;
    },
  };
  const relay = await startRelay({ port: 0, publicOrigin: ORIGIN, accounts: watched });
  relays.push(relay);
  return {
    relay,
    accounts,
    dataDir,
    authenticated: (token) => new Promise<void>((resolve) => waiting.set(token, resolve)),
  };
}

const post = (relay: Relay, path: string, body: unknown, token?: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${relay.port}${path}`, {
    method: "POST",
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

const login = async (relay: Relay, username: string, password = GOOD_PASSWORD): Promise<Response> =>
  post(relay, "/api/login", { username, password });

const BOB = "bob@example.com";

async function signUpBob(started: Started): Promise<string> {
  await addUser({ dataDir: started.dataDir, email: BOB, password: GOOD_PASSWORD });
  return ((await (await login(started.relay, BOB)).json()) as { token: string }).token;
}

/**
 * Sends the headers and half the body, revokes every session of the token's
 * account once the handler has authenticated it, then sends the rest. Plain
 * node:http rather than fetch with a streamed body: undici refuses a 401 to
 * a request whose body it cannot replay ("expected non-null body source").
 */
async function postRevokedMidBody(started: Started, path: string, body: unknown, token: string): Promise<number> {
  const userId = started.accounts.authenticate(token)!.userId;
  const text = JSON.stringify(body);
  const half = text.length >> 1;
  const authenticated = started.authenticated(token);
  const status = new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port: started.relay.port, path, method: "POST", headers: { authorization: `Bearer ${token}` } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.write(text.slice(0, half));
    void authenticated.then(() => {
      started.accounts.revokeAllSessions(userId);
      request.end(text.slice(half));
    });
  });
  return status;
}

describe("signed-in routes re-authenticate after reading the body", () => {
  it("does not delete an account whose session was revoked while the body arrived", async () => {
    const started = await startServer();
    const bob = await signUpBob(started);
    expect(await postRevokedMidBody(started, "/api/me/delete", { password: GOOD_PASSWORD }, bob)).toBe(401);
    expect((await login(started.relay, BOB)).status).toBe(200);
  });

  it("does not change the password of a session revoked while the body arrived", async () => {
    const started = await startServer();
    const admin = ((await (await login(started.relay, "admin")).json()) as { token: string }).token;
    const status = await postRevokedMidBody(
      started,
      "/api/password",
      { currentPassword: GOOD_PASSWORD, newPassword: NEW_PASSWORD },
      admin,
    );
    expect(status).toBe(401);
    expect((await login(started.relay, "admin", GOOD_PASSWORD)).status).toBe(200);
    expect((await login(started.relay, "admin", NEW_PASSWORD)).status).toBe(401);
  });

  // Every other signed-in route with a body, so a new one can't skip the rule.
  it.each([
    ["/api/push-tokens", { apns: APNS, environment: "production" }],
    ["/api/push-tokens/remove", { apns: APNS, environment: "production" }],
    ["/api/me/email/code", { email: "a@example.com", password: GOOD_PASSWORD }],
    ["/api/me/email", { email: "a@example.com", code: "123456", password: GOOD_PASSWORD }],
    [`/api/hosts/${HOST_ID}/remove`, { password: GOOD_PASSWORD }],
    ["/api/devices/1/kick", { password: GOOD_PASSWORD }],
    ["/api/host-link/lookup", { userCode: "ABCD-EFGH" }],
    ["/api/host-link/confirm", { userCode: "ABCD-EFGH" }],
    ["/api/host-link/deny", { userCode: "ABCD-EFGH" }],
    ["/api/logout", { revoke: true }],
  ])("%s answers 401 to a session revoked while the body arrived", async (path, body) => {
    const started = await startServer();
    const admin = ((await (await login(started.relay, "admin")).json()) as { token: string }).token;
    expect(await postRevokedMidBody(started, path, body, admin)).toBe(401);
  });
});

/**
 * Places in api.ts that act on a session as it stood before the body arrived:
 * a `readJson` call outside `authedJson` after the route authenticated, or,
 * after an `authedJson` call, a use of a variable that holds the earlier
 * `.authenticate` result. "After" is lexical: an earlier statement in an
 * enclosing block (or the condition of an enclosing `if`) calls
 * `sessionToken` or `.authenticate`. The unauthenticated routes (login,
 * sign-up, password reset, the host CLI's host-link calls) read with no
 * credential before.
 */
function staleSessionUses(source: string): string[] {
  const file = ts.createSourceFile("api.ts", source, ts.ScriptTarget.Latest, true);
  const at = (node: ts.Node): string => `api.ts:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const readsSession = (node: ts.Node): boolean =>
    (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "authenticate") ||
    ts.forEachChild(node, readsSession) === true;
  const authenticates = (node: ts.Node): boolean =>
    (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "sessionToken") ||
    readsSession(node) ||
    ts.forEachChild(node, authenticates) === true;
  const calls = (node: ts.Node, name: string): boolean =>
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;
  /** The enclosing blocks up to the function, innermost first, each with the statement that holds `node`. */
  const enclosing = (node: ts.Node): { block: ts.Block; holder: ts.Statement }[] => {
    const out: { block: ts.Block; holder: ts.Statement }[] = [];
    let child: ts.Node = node;
    for (let parent = node.parent; parent !== undefined && !ts.isFunctionLike(parent); child = parent, parent = parent.parent) {
      if (ts.isBlock(parent)) out.push({ block: parent, holder: child as ts.Statement });
    }
    return out;
  };
  const before = (block: ts.Block, holder: ts.Statement): readonly ts.Statement[] =>
    block.statements.slice(0, block.statements.indexOf(holder));
  const authenticatedBefore = (call: ts.Node): boolean => {
    for (let child: ts.Node = call, parent = call.parent; parent !== undefined && !ts.isFunctionLike(parent); child = parent, parent = parent.parent) {
      if (ts.isIfStatement(parent) && child !== parent.expression && authenticates(parent.expression)) return true;
    }
    return enclosing(call).some(({ block, holder }) =>
      before(block, holder).some((statement) => authenticates(ts.isIfStatement(statement) ? statement.expression : statement)),
    );
  };
  /** Names declared from an `.authenticate` result before `call`. */
  const earlierSessions = (call: ts.Node): Set<string> => {
    const names = new Set<string>();
    for (const { block, holder } of enclosing(call)) {
      for (const statement of before(block, holder)) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined && readsSession(declaration.initializer)) {
            names.add(declaration.name.text);
          }
        }
      }
    }
    return names;
  };
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (calls(node, "readJson") && authenticatedBefore(node)) {
      const fn = ts.findAncestor(node, ts.isFunctionDeclaration);
      if (fn?.name?.text !== "authedJson") violations.push(`${at(node)} reads the body after authenticating`);
    }
    if (calls(node, "authedJson")) {
      const stale = earlierSessions(node);
      const innermost = enclosing(node)[0];
      if (innermost !== undefined && stale.size > 0) {
        const after = innermost.block.statements.slice(innermost.block.statements.indexOf(innermost.holder) + 1);
        const use = (inner: ts.Node): void => {
          const isMemberName = ts.isPropertyAccessExpression(inner.parent) && inner.parent.name === inner;
          if (ts.isIdentifier(inner) && !isMemberName && stale.has(inner.text)) violations.push(`${at(inner)} uses ${inner.text} from before the body`);
          ts.forEachChild(inner, use);
        };
        after.forEach(use);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}

describe("signed-in body reads go through authedJson", () => {
  it("api.ts acts on no session from before the body", () => {
    const source = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
    expect(staleSessionUses(source)).toEqual([]);
  });

  it("flags reading the body after authenticating, and a session kept from before it", () => {
    const bad = `
      async function handle() {
        if (pathname === "/api/login") {
          const body = await readJson(request);
        }
        if (pathname === "/api/thing") {
          const token = sessionToken(request);
          if (token === undefined || accounts.authenticate(token) === undefined) return;
          const body = await readJson(request);
        }
        if (accounts.authenticate(token) !== undefined) {
          await readJson(request);
        }
        if (pathname === "/api/other") {
          const session = accounts.authenticate(token);
          const body = await authedJson(accounts, request, token);
          act(body.session.userId);
          act(session.userId);
        }
      }`;
    expect(staleSessionUses(bad)).toEqual([
      "api.ts:9 reads the body after authenticating",
      "api.ts:12 reads the body after authenticating",
      "api.ts:18 uses session from before the body",
    ]);
  });
});
