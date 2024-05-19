import sql from "./db.ts";

export const dbCountUsers = async (): Promise<number | null> => {
  try {
    // Query to count the number of users in the users table
    const result = await sql`SELECT COUNT(*) as count FROM users`;
    const userCount = result[0].count;
    return userCount;
  } catch (error) {
    console.error("Error querying the users table:", error);
    return null;
  }
};
