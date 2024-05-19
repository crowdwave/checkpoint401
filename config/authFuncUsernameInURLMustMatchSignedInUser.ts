import {getUserIdFromRequest} from "./getUserIdFromRequest.ts";
import {queryGetUser} from "./queryGetUser.ts";
import {UserMinimal} from "./types.ts";


export default async function authFuncUsernameInURLMustMatchSignedInUser(
    req: Request,
    match: URLPatternResult | null,
): Promise<boolean> {
    const userId = await getUserIdFromRequest(req);
    if (!userId) return false;
    const userFromDb: UserMinimal | null = await queryGetUser(undefined, undefined, userId);
    if (!userFromDb) return false
    return match?.pathname?.groups?.username === userFromDb.username;
}
