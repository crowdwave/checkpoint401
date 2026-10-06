import sql from "./db.ts";
import {UserMinimal} from "./types.ts";

export const sqlStatementGetUserMinimal = (
    username: string | undefined,
    email: string | undefined,
    id: string | undefined,
): Promise<UserMinimal[]> | null => {
    if (username !== undefined) {
        return sql<UserMinimal[]>`
            SELECT id,
                   username
            FROM users
            WHERE users.username = ${username}
        `;
    }
    if (email !== undefined) {
        return sql<UserMinimal[]>`
            SELECT id,
                   username
            FROM users
            WHERE users.email = ${email}
        `;
    }
    if (id !== undefined) {
        return sql<UserMinimal[]>`
            SELECT id,
                   username
            FROM users
            WHERE users.id = ${id}
        `;
    }
    return null;
};
