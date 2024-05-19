import sql from "./db.ts";
import {PendingQuery} from "https://deno.land/x/postgresjs@v3.4.4/types/index.d.ts";

export const sqlStatementGetUserMinimal = (
    username: string | undefined,
    email: string | undefined,
    id: string | undefined,
): PendingQuery<any> | null => {
    if (username !== undefined) {
        return sql`
            SELECT id,
                   username
            FROM users
            WHERE users.username = ${username}
        `;
    }
    if (email !== undefined) {
        return sql`
            SELECT id,
                   username
            FROM users
            WHERE users.email = ${email}
        `;
    }
    if (id !== undefined) {
        return sql`
            SELECT id,
                   username
            FROM users
            WHERE users.id = ${id}
        `;
    }
    return null;
};
