import sql from "./db.ts";
import {PendingQuery} from "https://deno.land/x/postgresjs@v3.4.4/types/index.d.ts";

export const sqlStatementIsUserAMemberOfChannel = (user_id: string, channel_id: string): PendingQuery<any> => {
    return sql`
        SELECT EXISTS (SELECT 1
                       FROM public.channel_members cm
                                JOIN public.channels c ON cm.channel_id = c.channel_id
                       WHERE cm.user_id = ${user_id}
                         AND c.channel_id = ${channel_id})
    `;
};

