export default async function getUsers(req: Request, match: URLPatternResult | null): Promise<boolean> {
    return new Promise((resolve, reject) => {
        // Example logic to validate user
        const userId = 2;
        const users = [
            {id: 1, name: "User 1"},
            {id: 2, name: "User 2"},
            {id: 3, name: "User 3"}
        ];

        // Check if the request contains a user with an id of 2
        const userExists = users.some(user => user.id === userId);
        resolve(userExists);
    });
}