import sql from "./db.ts";

export const sqlStatementIsUserAMemberOfChannel = (user_id: string, channel_id: string): Promise<{ exists: boolean }[]> => {
    return sql<{ exists: boolean }[]>`
        SELECT EXISTS (SELECT 1
                       FROM public.channel_members cm
                                JOIN public.channels c ON cm.channel_id = c.channel_id
                       WHERE cm.user_id = ${user_id}
                         AND c.channel_id = ${channel_id})
    `;
};
