import {verify} from "jsr:@zaubrik/djwt@3.0.2";
import {env} from "./env.ts";
import {InvalidJwtTokenError, JwtSecretNotSetError, MissingJwtTokenError, NoCookiesFoundError, rethrowCatchInAuth} from "./customErrors.ts";

interface DecodedToken {
    id?: unknown;
    exp?: unknown;
    nbf?: unknown;
}

// djwt v3 takes a CryptoKey. Import it once; verify() then enforces that
// the token's 'alg' header matches the key's algorithm (HS256), so
// 'alg: none' and algorithm-confusion tokens are rejected.
const MIN_SECRET_BYTES = 32; // 256 bits, per RFC 7518 §3.2 for HS256.
const hmacKeyPromise: Promise<CryptoKey> = (async () => {
    if (!env.JWT_SECRET) throw new JwtSecretNotSetError();
    const raw = new TextEncoder().encode(env.JWT_SECRET);
    if (raw.byteLength < MIN_SECRET_BYTES) {
        throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_BYTES} bytes for HS256 (got ${raw.byteLength}).`);
    }
    return await crypto.subtle.importKey("raw", raw, {name: "HMAC", hash: "SHA-256"}, false, ["verify"]);
})();
// Surface a bad secret at startup rather than on the first request.
await hmacKeyPromise;

export async function checkCookieIsValidReturningUserId(req: Request): Promise<string> {
    try {
        const cookies: string | null = req.headers.get("Cookie");
        if (!cookies) throw new NoCookiesFoundError();
        const jwtCookie = cookies.split(/;\s*/).find((c) => c.startsWith("token="));
        if (!jwtCookie) throw new MissingJwtTokenError();
        const token = jwtCookie.slice(jwtCookie.indexOf("=") + 1);
        let decoded: DecodedToken;
        try {
            decoded = await verify(token, await hmacKeyPromise) as DecodedToken;
        } catch {
            // djwt's own Error types are not "known" errors; map them so a
            // garbage cookie from an anonymous caller does not trip the
            // ALERT DEVELOPERS log line.
            throw new InvalidJwtTokenError();
        }
        // Defensive expiry / not-before check. djwt rejects expired and
        // not-yet-valid tokens, but only when the claims are present;
        // require exp so a token without one can't be valid forever.
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (typeof decoded.exp !== "number" || decoded.exp <= nowSeconds) {
            throw new MissingJwtTokenError();
        }
        if (typeof decoded.nbf === "number" && decoded.nbf > nowSeconds) {
            throw new MissingJwtTokenError();
        }
        if (typeof decoded.id !== "string" || decoded.id.length === 0) {
            throw new MissingJwtTokenError();
        }
        return decoded.id;
    } catch (error) {
        throw rethrowCatchInAuth(error);
    }
}
