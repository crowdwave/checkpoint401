import {checkCookieIsValidReturningUserId} from "./checkCookieIsValidReturningUserId.ts";
import {sqlQueryIsUserAMemberOfChannel} from "./sqlQueryIsUserAMemberOfChannel.ts";
import {
    InternalApplicationError,
    rethrowCatchInAuth,
    UserNotAMemberOfChannelError,
} from "./customErrors.ts";
import {checkUserExistsReturningUserMinimal} from "./checkUserExistsReturningUserMinimal.ts";

export default async function authFuncSignedInUserMustBeAMemberOfTheChannel(
    req: Request,
    match: URLPatternResult | null,
): Promise<{ success: boolean, errorMessage?: string }> {
    try {
        // validate cookie, get userId
        const user_id = await checkCookieIsValidReturningUserId(req);

        // check if user exists
        await checkUserExistsReturningUserMinimal(undefined, undefined, user_id);

        // check if the user is a member of the channel
        const channel_id = match?.pathname?.groups?.channel_id;
        if (!channel_id) throw new InternalApplicationError(`authFuncSignedInUserMustBeAMemberOfTheChannel channel_id ${channel_id}`);
        const isUserAMemberOfChannel: boolean = await sqlQueryIsUserAMemberOfChannel(user_id, channel_id);
        console.log(isUserAMemberOfChannel)
        // signed in user is a member of the channel
        if (isUserAMemberOfChannel) return {success: true};
        throw new UserNotAMemberOfChannelError();
    } catch (error) {
        throw rethrowCatchInAuth(error);
    }
}
