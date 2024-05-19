import {getUserIdFromRequest} from "./getUserIdFromRequest.ts";
import {queryGetUser} from "./queryGetUser.ts";
import {UserMinimal} from "./types.ts";


export default async function authFuncUsernameInURLMustMatchSignedInUser(
    req: Request,
    match: URLPatternResult | null,
): Promise<{ success: boolean; errorMessage?: string; }> {
    const userId = await getUserIdFromRequest(req);
    if (!userId) return { success: false, errorMessage: "Failed to get ID from cookie"};
    const userFromDb: UserMinimal | null = await queryGetUser(undefined, undefined, userId);
    if (!userFromDb) return { success: false, errorMessage: "User not found"}
    const outcome  = match?.pathname?.groups?.username === userFromDb.username;
    if (outcome) {
        return { success: true}
    } else {
        return { success: false, errorMessage: "User not found"}
    }
}
