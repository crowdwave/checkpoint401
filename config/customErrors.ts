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

// One line, control characters stripped, length bounded: these log
// sites are reachable by unauthenticated callers and must be neither a
// log-forging nor a log-flooding vector. (Config modules cannot import
// the server's own helper without running the server.)
const MAX_LOG_FIELD = 512;
export function logSafe(s: string): string {
    const cleaned = s.replace(/[\x00-\x1f\x7f]/g, "?");
    return cleaned.length > MAX_LOG_FIELD ? cleaned.slice(0, MAX_LOG_FIELD) + "...[truncated]" : cleaned;
}

export function describeError(error: unknown): string {
    return error instanceof Error ? `${error.name} - ${error.message}` : `${typeof error} - ${String(error)}`;
}

export function rethrowCatchInAuth(error: unknown): never {
    if (error instanceof Error && knownErrorNames.includes(error.name)) {
        throw error;
    } else {
        console.error(`ALERT DEVELOPERS! ERROR WAS NOT IN KNOWN ERRORS: ${logSafe(describeError(error))}`);
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
        console.error(`InternalApplicationError ALERT DEVELOPERS! - ${logSafe(info)}`);
    }
}

export class UserIsNotSignedInError extends Error {
    constructor() {
        super("User is not signed in error");
        this.name = "UserIsNotSignedInError";
    }
}

