import {config, DotenvConfig} from "https://deno.land/x/dotenv@v3.2.2/mod.ts";
import {verify} from "https://deno.land/x/djwt@v2.2/mod.ts";
import {JwtSecretNotSetError, knownErrorNames, MissingJwtTokenError, NoCookiesFoundError, rethrowCatchInAuth, UnknownAuthError} from "./customErrors.ts";

const env: DotenvConfig = config({path: ".env"});

interface DecodedToken {
    id: string;
    exp?: number;
    nbf?: number;
}

export async function checkCookieIsValidReturningUserId(req: Request): Promise<string> {
    try {
        if (!env.JWT_SECRET) throw new JwtSecretNotSetError();
        const cookies: string | null = req.headers.get("Cookie");
        if (!cookies) throw new NoCookiesFoundError();
        const jwtCookie = cookies.split(/;\s*/).find((c) => c.startsWith("token="));
        if (!jwtCookie) throw new MissingJwtTokenError();
        const token = jwtCookie.slice(jwtCookie.indexOf("=") + 1);
        const decoded = await verify(token, env.JWT_SECRET, "HS256") as unknown as DecodedToken;
        // Defensive expiry / not-before check. djwt should reject these
        // already, but enforce here so a token without an exp claim
        // can't be valid forever, and so behaviour is correct even if
        // the underlying lib relaxes its checks.
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (typeof decoded.exp !== "number" || decoded.exp <= nowSeconds) {
            throw new MissingJwtTokenError();
        }
        if (typeof decoded.nbf === "number" && decoded.nbf > nowSeconds) {
            throw new MissingJwtTokenError();
        }
        return decoded.id;
    } catch (error) {
        throw rethrowCatchInAuth(error);
    }
}
