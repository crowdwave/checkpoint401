import {config, DotenvConfig} from "https://deno.land/x/dotenv@v3.2.2/mod.ts";
import {verify} from "https://deno.land/x/djwt@v2.2/mod.ts";
import {JwtSecretNotSetError, knownErrorNames, MissingJwtTokenError, NoCookiesFoundError, rethrowCatchInAuth, UnknownAuthError} from "./customErrors.ts";

const env: DotenvConfig = config({path: ".env"});

interface DecodedToken {
    id: string;
}

export async function checkCookieIsValidReturningUserId(req: Request): Promise<string> {
    try {
        if (!env.JWT_SECRET) throw new JwtSecretNotSetError();
        const cookies: string | null = req.headers.get("Cookie");
        if (!cookies) throw new NoCookiesFoundError();
        const jwtCookie = cookies.split("; ").find((c) => c.startsWith("token="));
        if (!jwtCookie) throw new MissingJwtTokenError();
        const token = jwtCookie.split("=")[1];
        const decoded = await verify(token, env.JWT_SECRET, "HS256") as unknown as DecodedToken;
        return decoded.id;
    } catch (error) {
        throw rethrowCatchInAuth(error);
    }
}
