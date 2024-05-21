import {sqlStatementGetUserMinimal} from "./sqlStatementGetUserMinimal.ts";
import {UserMinimal} from "./types.ts";
import {InternalApplicationError, rethrowCatchInAuth, UserNotFoundError} from "./customErrors.ts";


export const checkUserExistsReturningUserMinimal = async (
    username?: string | undefined,
    email?: string | undefined,
    id?: string | undefined,
): Promise<UserMinimal> => {
    try {
        if (!username && !email && !id) {
            throw new InternalApplicationError(`checkUserExistsReturningUserMinimal AT LEAST ONE ARGUMENT MUST BE PROVIDED`);
        }
        const result = await sqlStatementGetUserMinimal(username, email, id);
        if (result === null) throw new UserNotFoundError();
        if (result.length !== 1) throw new UserNotFoundError();
        const userFromDb: UserMinimal = result[0]
        if (!(userFromDb.id && userFromDb.username)) {
            throw new InternalApplicationError(`checkUserExistsReturningUserMinimal ${username} ${email} ${id} `)
        }
        return userFromDb;
    } catch (error) {
        throw rethrowCatchInAuth(error);
    }
};
