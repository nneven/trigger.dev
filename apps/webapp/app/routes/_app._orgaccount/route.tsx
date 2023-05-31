import { Outlet } from "@remix-run/react";
import { PageContainer, PageBody } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import {
  PageHeader,
  PageTitleRow,
  PageTitle,
  PageButtons,
  PageDescription,
  PageTabs,
} from "~/components/primitives/PageHeader";
import {
  newOrganizationPath,
  organizationsPath,
  accountPath,
} from "~/utils/pathBuilder";

export default function Page() {
  return (
    <PageContainer>
      <PageHeader hideBorder>
        <PageTitleRow>
          <PageTitle title="Organizations and Account" />
          <PageButtons>
            <LinkButton
              to={newOrganizationPath()}
              variant="primary/small"
              shortcut="N"
            >
              Create a new Organization
            </LinkButton>
          </PageButtons>
        </PageTitleRow>
        <PageDescription>
          Create new Organizations and manage your account.
        </PageDescription>
        <PageTabs
          tabs={[
            { label: "Organizations", to: organizationsPath() },
            { label: "Account", to: accountPath() },
          ]}
        />
      </PageHeader>
      <PageBody>
        <Outlet />
      </PageBody>
    </PageContainer>
  );
}
