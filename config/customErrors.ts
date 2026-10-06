export const knownErrorNames: string[] = [
    "InternalApplicationError",
    "InvalidUrlError",
    "JwtSecretNotSetError",
    "MissingJwtTokenError",
    "NoCookiesFoundError",
    "UnknownAuthError",
    "UserNotAMemberOfChannelError",
    "UserNotFoundError",
    "UsernameInUrlDoesNotMatchSignedInUserError",
    "UserIsNotSignedInError",
];

export function rethrowCatchInAuth(error: unknown): never {
    if (error instanceof Error && knownErrorNames.includes(error.name)) {
        throw error;
    } else {
        const name = error instanceof Error ? error.name : typeof error;
        const message = error instanceof Error ? error.message : String(error);
        // Single line, control characters stripped: this is reachable by
        // unauthenticated callers and must not be a log-forging vector.
        console.error(`ALERT DEVELOPERS! ERROR WAS NOT IN KNOWN ERRORS: ${name} - ${message}`.replace(/[\x00-\x1f\x7f]/g, "?"));
        throw new UnknownAuthError();
    }
}

export class InvalidUrlError extends Error {
    constructor() {
        super("Invalid URL");
        this.name = "InvalidUrlError";
    }
}

export class UserNotAMemberOfChannelError extends Error {
    constructor() {
        super("User is not a member of the specified channel");
        this.name = "UserNotAMemberOfChannelError";
    }
}

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
    constructor(info: string) {
        super("Internal application error");
        this.name = "InternalApplicationError";
        // this should not happen in production
        console.error(`InternalApplicationError ALERT DEVELOPERS! - ${info}`.replace(/[\x00-\x1f\x7f]/g, "?"));
    }
}

export class UserIsNotSignedInError extends Error {
    constructor() {
        super("User is not signed in error");
        this.name = "UserIsNotSignedInError";
    }
}

