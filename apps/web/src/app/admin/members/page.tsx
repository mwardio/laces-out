import type { Metadata } from "next";

import { AppShell } from "../../../components/app-shell";
import { MemberInvitations } from "../../../components/member-invitations";

export const metadata: Metadata = {
  title: "Members & Invitations",
  description: "Invite friends and scope their Laces Out league access.",
  robots: { index: false, follow: false },
};

export default function MembersPage() {
  return (
    <AppShell
      active="members"
      context={{ label: "Administration", detail: "Invite-only access", tone: "setup" }}
    >
      <MemberInvitations />
    </AppShell>
  );
}
