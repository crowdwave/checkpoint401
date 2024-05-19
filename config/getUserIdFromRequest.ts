import {config} from "https://deno.land/x/dotenv@v3.2.2/mod.ts";
import {verify} from "https://deno.land/x/djwt@v2.2/mod.ts";

const env = config({path: ".env"});

interface DecodedToken {
    id: string;
}

export async function getUserIdFromRequest(req: Request): Promise<string | null> {

    if (!env.JWT_SECRET) {
        console.log(`env.JWT_SECRET IS NOT SET!`);
        return null;
    }

    const cookies = req.headers.get("Cookie");
    if (!cookies) {
        console.log(`Unauthorized: No cookies found`);
        return null;
    }

    const jwtCookie = cookies.split("; ").find((c) => c.startsWith("token="));
    if (!jwtCookie) {
        console.log("Unauthorized: Missing JWT token in cookie");
        return null;
    }

    const token = jwtCookie.split("=")[1];

    try {
        const decoded = await verify(token, env.JWT_SECRET, "HS256") as unknown as DecodedToken;
        return decoded.id;
    } catch (error) {
        console.log("Unauthorized: Invalid JWT token");
        return null;
    }
}
