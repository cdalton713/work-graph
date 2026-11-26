import type { LinearAccess, ShareLink, ShareMember } from "./types";

export function linkRow(link: ShareLink, url?: string) {
  if (url) return { state: "new", url } as const;
  if (link.exists) return { state: "live", made: link.createdAt } as const;
  return { state: "missing" } as const;
}

export function accessNotice(access: LinearAccess) {
  switch (access.status) {
    case "ok": return null;
    case "no_connection": return { message: `Connect to the ${access.workspace} Linear workspace.`, action: "settings" } as const;
    case "no_team": return { message: `You need access to team ${access.team} in Linear.`, action: "request" } as const;
    case "not_member": return { message: `You need to join the ${access.workspace} Linear workspace.`, action: "request" } as const;
  }
}

export function orderMembers(members: ShareMember[]) {
  return members.toSorted((a, b) => a.role.localeCompare(b.role) ||
    Date.parse(a.joinedAt) - Date.parse(b.joinedAt) || a.id.localeCompare(b.id));
}
