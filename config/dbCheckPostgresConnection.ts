import sql from "./db.ts";

export const dbCheckPostgresConnection = async (): Promise<boolean> => {
  try {
    // A simple query to check if the database is responding
    await sql`SELECT 1`;
    return true;
  } catch (error) {
    console.error("Error connecting to the database:", error);
    return false;
  }
};
