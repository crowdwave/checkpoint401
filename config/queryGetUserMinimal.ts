import {sqlStatementGetUserMinimal} from "./sqlStatementGetUserMinimal.ts";
import {UserMinimal} from "./types.ts";
import {InternalApplicationError, UnknownAuthError, UserNotFoundError} from "./customErrors.ts";


export const queryGetUserMinimal = async (
    username?: string | undefined,
    email?: string | undefined,
    id?: string | undefined,
): Promise<UserMinimal> => {
    try {
        if (username === undefined && email === undefined && id === undefined) {
            console.error("INTERNAL PROGRAM ERROR: AT LEAST ONE ARGUMENT MUST BE PROVIDED");
            throw new InternalApplicationError();
        }
        const result = await sqlStatementGetUserMinimal(username, email, id);
        if (result === null) throw new UserNotFoundError();
        if (result.length !== 1) throw new UserNotFoundError();
        return result[0];
    } catch (err) {
        console.error("Error in queryGetUserMinimal:", err);
        throw new UnknownAuthError();
    }
};
