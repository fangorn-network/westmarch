// Types for the westmarch JS modules the TypeScript files import, by their package
// names. Only what those files use; widen as more of westmarch moves to TypeScript.

type Row = { id: string; text?: string; vector?: unknown; [field: string]: unknown };
type Roles = { title: string[]; subtitle: string[]; tags: string[]; text: string[]; declared?: boolean; [k: string]: unknown };
type Manifest = { role_map?: Record<string, unknown>; presentation?: Record<string, unknown>; [k: string]: unknown };

declare module "@fangorn-network/westmarch/shard" {
    export function configure(hooks: {
        rowText?: (fields: Record<string, unknown>, view: string) => string;
        onManifests?: (manifests: Manifest[], view: string) => void;
    }): void;
    export function loadShard(base: string): Promise<Row[]>;
    export function trimView(url: string): string;
}

declare module "@fangorn-network/westmarch/roles" {
    export function rolesFrom(manifests?: Manifest[], sample?: Row[]): Roles;
    export function textOf(row: Record<string, unknown>, roles: Roles): string;
    export function titleOf(row: Row, roles: Roles): string;
    export function subtitleOf(row: Row, roles: Roles): string | null;
    export function values(v: unknown): string[];
}

declare module "@fangorn-network/westmarch/tools" {
    export type Brief = { id: string; title: string; score: number; mode: string; [k: string]: unknown };
    export function search(rows: Row[], query: string, roles: Roles,
        opts?: { qv?: Float32Array | number[] | null; limit?: number; where?: Record<string, string>; lexBoost?: number }): Brief[];
    export function matches(row: Row, where?: Record<string, string>): boolean;
}

declare module "@fangorn-network/westmarch/embed" {
    export const EMBED_MODEL: string;
    export function embedQueryDirect(text: string): Promise<Float32Array>;
}
