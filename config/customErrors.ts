export const knownErrorNames: string[] = [
    "JwtSecretNotSetError",
    "UserNotFoundError",
    "NoCookiesFoundError",
    "MissingJwtTokenError",
    "UnknownAuthError",
    "UsernameInUrlDoesNotMatchSignedInUserError",
    "InternalApplicationError",
];

export class JwtSecretNotSetError extends Error {
    constructor() {
        super(`env.JWT_SECRET IS NOT SET!`);
        this.name = "JwtSecretNotSetError";
    }
}

export class UserNotFoundError extends Error {
    constructor() {
        super(`Unauthorized: User not found`);
        this.name = "UserNotFoundError";
    }
}

export class NoCookiesFoundError extends Error {
    constructor() {
        super(`Unauthorized: No cookies found`);
        this.name = "NoCookiesFoundError";
    }
}

export class MissingJwtTokenError extends Error {
    constructor() {
        super("Unauthorized: Missing JWT token in cookie");
        this.name = "MissingJwtTokenError";
    }
}

export class UnknownAuthError extends Error {
    constructor() {
        super("Unknown auth error");
        this.name = "UnknownAuthError";
    }
}

export class UsernameInUrlDoesNotMatchSignedInUserError extends Error {
    constructor() {
        super("Username in Url does not match signed in user");
        this.name = "UsernameInUrlDoesNotMatchSignedInUserError";
    }
}
export class InternalApplicationError extends Error {
    constructor() {
        super("Internal application error");
        this.name = "InternalApplicationError";
    }
}

