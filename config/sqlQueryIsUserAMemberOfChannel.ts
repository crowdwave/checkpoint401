import {sqlStatementIsUserAMemberOfChannel} from "./sqlStatementIsUserAMemberOfChannel.ts";
import {rethrowCatchInAuth} from "./customErrors.ts";

export const sqlQueryIsUserAMemberOfChannel = async (user_id: string, channel_id: string): Promise<boolean> => {
    try {
        const result = await sqlStatementIsUserAMemberOfChannel(user_id, channel_id);
        return result[0].exists;
    } catch (error) {
        throw rethrowCatchInAuth(error);
    }
};


/*
async function logIsUserAMemberOfChannel(user_id: string, channel_id: string) {
    try {
        const query = sqlStatementIsUserAMemberOfChannel(user_id, channel_id);
        const result = await query.execute();
        console.log(`Result for user_id: ${user_id} and channel_id: ${channel_id} is: ${result.rows[0].exists}`);
    } catch (err) {
        console.error(`Error in logIsUserAMemberOfChannel for user_id: ${user_id} and channel_id: ${channel_id}. Error: ${err}`);
    }
}*/
