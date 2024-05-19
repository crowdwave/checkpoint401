import { sqlStatementGetUserMinimal } from "./sqlStatementGetUserMinimal.ts";
import { UserMinimal } from "./types.ts";


export const queryGetUser = async (
    username?: string | undefined,
    email?: string | undefined,
    id?: string | undefined,
    ): Promise<UserMinimal | null> => {
  if (username === undefined && email === undefined && id === undefined) {
    throw new Error("At least one argument must be provided");
  }

  try {
    const result = await sqlStatementGetUserMinimal(username, email, id);
    return result[0];
  } catch (err) {
    return null;
  }
};
