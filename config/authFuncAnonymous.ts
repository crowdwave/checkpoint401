
export default async function authFuncAnonymous(req: Request, match: URLPatternResult | null): Promise<{ success: boolean; errorMessage?: string; }> {
    return { success: true}
}

