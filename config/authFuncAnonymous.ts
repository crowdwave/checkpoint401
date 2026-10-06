export default function authFuncAnonymous(_req: Request, _match: URLPatternResult | null): Promise<{ success: boolean, errorMessage?: string }> {
    return Promise.resolve({success: true});
}
