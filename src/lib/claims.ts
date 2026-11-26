export interface Claim {
  node: string;
  holder: string;
  job: string;
  claimedAt: string;
  renewedAt: string;
  leaseUntil: string;
  stale: boolean;
  mine?: boolean;
}

export interface ProjectClaims {
  claims: Claim[];
  role?: "owner" | "collaborator" | "viewer";
}

export interface ClaimMark extends Claim {
  initials: string;
}

export type ClaimFilter = "mine" | "theirs" | "all";

export function parseClaimFilter(value: string | null): ClaimFilter {
  return value === "mine" || value === "theirs" ? value : "all";
}

export function matchesClaim(claim: Claim | undefined, filter: ClaimFilter): boolean {
  return filter === "all" || claim?.mine === (filter === "mine");
}

export function canReleaseClaim(claim: Claim | undefined, role: ProjectClaims["role"]): boolean {
  return role === "owner" && claim?.mine === false && claim.stale === true;
}

export function claimMarks(claims: Claim[]): Map<string, ClaimMark> {
  return new Map(claims.map((claim) => [claim.node, {
    ...claim,
    initials: claim.holder.trim().split(/\s+/u).slice(0, 2).map((word) => Array.from(word)[0]).join("").toLocaleUpperCase() || "?",
  }]));
}
