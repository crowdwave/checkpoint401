import {getUserIdFromRequest} from "./getUserIdFromRequest.ts";
import {queryGetUserMinimal} from "./queryGetUserMinimal.ts";
import {UserMinimal} from "./types.ts";
import {UsernameInUrlDoesNotMatchSignedInUserError, UserNotFoundError} from "./customErrors.ts";

export default async function authFuncUsernameInURLMustMatchSignedInUser(
    req: Request,
    match: URLPatternResult | null,
): Promise<{ success: boolean, errorMessage?: string }> {
    try {
        const userId = await getUserIdFromRequest(req);
        const userFromDb: UserMinimal = await queryGetUserMinimal(undefined, undefined, userId);
        if (!userFromDb.id) throw new UserNotFoundError();
        if (!userFromDb.username) throw new UserNotFoundError();
        const outcome: boolean = match?.pathname?.groups?.username === userFromDb.username;
        if (outcome) return {success: true};
        throw new UsernameInUrlDoesNotMatchSignedInUserError();
    } catch (error) {
        return {success: false, errorMessage: error.message};
    }
}
