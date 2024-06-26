import {checkCookieIsValidReturningUserId} from "./checkCookieIsValidReturningUserId.ts";
import {checkUserExistsReturningUserMinimal} from "./checkUserExistsReturningUserMinimal.ts";
import {UserMinimal} from "./types.ts";
import {rethrowCatchInAuth, UsernameInUrlDoesNotMatchSignedInUserError} from "./customErrors.ts";

export default async function authFuncUsernameInURLMustMatchSignedInUser(
    req: Request,
    match: URLPatternResult | null,
): Promise<{ success: boolean, errorMessage?: string }> {
    try {
        // check if the cookie contains a valid user_id
        const user_id = await checkCookieIsValidReturningUserId(req);

        // ensure the user exists
        const userFromDb: UserMinimal = await checkUserExistsReturningUserMinimal(undefined, undefined, user_id);

        // compare username to the username in the URL
        if (match?.pathname?.groups?.username === userFromDb.username) return {success: true};
        throw new UsernameInUrlDoesNotMatchSignedInUserError();
    } catch (error) {
        throw rethrowCatchInAuth(error);
    }
}
