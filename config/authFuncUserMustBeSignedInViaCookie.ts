import {checkCookieIsValidReturningUserId} from "./checkCookieIsValidReturningUserId.ts";
import {checkUserExistsReturningUserMinimal} from "./checkUserExistsReturningUserMinimal.ts";
import {UserMinimal} from "./types.ts";
import {rethrowCatchInAuth, UserIsNotSignedInError} from "./customErrors.ts";


export default async function authFuncUserMustBeSignedInViaCookie(
    req: Request,
    match: URLPatternResult | null,
): Promise<{ success: boolean, errorMessage?: string }> {

    try {
        // validate cookie, get userId
        const user_id = await checkCookieIsValidReturningUserId(req);

        // make sure user exists
        const userFromDb: UserMinimal = await checkUserExistsReturningUserMinimal(undefined, undefined, user_id);
        if (userFromDb.id && userFromDb.username) return {success: true};

        // user does not exist
        throw new UserIsNotSignedInError();
    } catch (error) {
        throw rethrowCatchInAuth(error);
    }
}
