import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Copy,
  Globe,
  LoaderCircle,
  Pencil,
  RotateCw,
  Sparkles,
} from "lucide-react";
import { formatTime } from "./i18n.ts";
import {
  deploymentPhase,
  formatBytes,
  siteHost,
  siteMenu,
  sitePhase,
  type Deployment,
  type Page,
  type Site,
} from "./model.ts";
import {
  useView,
  Loading,
  PromptMenu,
  Alert,
  Section,
  Field,
  Meta,
  StatusLabel,
  PhaseIcon,
  Switch,
  RelativeTime,
} from "./parts.tsx";
import type { ViewState } from "./parts.tsx";
import { DeploymentDetail } from "./siteDeploymentView.tsx";

export function SitePage({ state }: { state: ViewState }) {
  const { t, actions } = useView();
  const { route, site } = state;
  if (route.page !== "site" && route.page !== "deployment") return null;
  if (!site || site.id !== route.siteId) return <Loading />;
  const tab =
    route.page === "deployment" || route.tab === "deployments" ? "deployments" : "overview";
  const latest = site.latestDeployment;
  const published = site.currentDeployment?.finishedAt ?? site.currentDeployment?.createdAt;
  return (
    <div className="stack-5">
      <nav className="crumbs" aria-label={t("sites.title")}>
        <button
          type="button"
          className="btn ghost sm back"
          onClick={() => actions.navigate({ page: "list" })}
        >
          <ChevronLeft />
          {t("sites.title")}
        </button>
        <span className="subtlest" aria-hidden="true">
          /
        </span>
        <span className="truncate">{site.name}</span>
      </nav>
      <header className="site-head">
        <div className="site-head-text">
          <div className="title-row">
            <h1 className="wrap">{site.name}</h1>
            <button
              type="button"
              className="icon-btn sm"
              aria-label={t("sites.site.rename")}
              title={t("sites.site.rename")}
              onClick={actions.startRename}
            >
              <Pencil />
            </button>
          </div>
          <Meta>
            <StatusLabel phase={sitePhase(site)} />
            {published && <RelativeTime iso={published} />}
          </Meta>
        </div>
        <div className="head-actions">
          <PromptMenu
            items={siteMenu(state.commands, site)}
            label={t("sites.site.redeploy")}
            icon={<RotateCw />}
          />
          <button
            type="button"
            className="btn primary lg"
            disabled={site.status !== "online"}
            onClick={() => actions.openLink(site.url)}
          >
            {t("sites.visit")}
            <ArrowUpRight />
          </button>
        </div>
      </header>
      {site.offlineReason === "review_rejected" ? (
        <Alert title={t("sites.status.offline")} lines={[t("sites.site.reviewRejected")]} />
      ) : (
        latest?.status === "failed" && (
          <Alert
            title={t("sites.site.failed")}
            lines={[
              latest.failure
                ? t("sites.site.failedAt", {
                    stage: t(`sites.stage.${latest.failure.stage}`),
                    message: latest.failure.message,
                  })
                : "",
              site.currentDeployment ? t("sites.site.stillOnline") : "",
            ]}
          />
        )
      )}
      <div className="tabs" role="tablist">
        <TabButton
          active={tab === "overview"}
          onClick={() => actions.navigate({ page: "site", siteId: site.id })}
        >
          {t("sites.site.overview")}
        </TabButton>
        <TabButton
          active={tab === "deployments"}
          onClick={() => actions.navigate({ page: "site", siteId: site.id, tab: "deployments" })}
        >
          {t("sites.site.deployments")}
          {state.deployments && state.deployments.items.length > 0 && (
            <span className="tab-count">
              {state.deployments.items.length}
              {state.deployments.nextCursor ? "+" : ""}
            </span>
          )}
        </TabButton>
      </div>
      {route.page === "deployment" ? (
        <DeploymentDetail state={state} site={site} />
      ) : tab === "deployments" ? (
        <DeploymentList site={site} deployments={state.deployments} />
      ) : (
        <Overview state={state} site={site} />
      )}
      {state.rename && <RenameDialog site={site} rename={state.rename} />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`tab${active ? " active" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Overview({ state, site }: { state: ViewState; site: Site }) {
  const { t, locale, timeZone, actions } = useView();
  const current = site.currentDeployment;
  const latest = site.latestDeployment;
  const removable = state.usage?.badgeRemovable ?? false;
  return (
    <div className="stack-5">
      <Section title={t("sites.site.production")}>
        {current ? (
          <dl className="card fields">
            <Field label={t("sites.site.domain")}>
              <span className="row gap-1">
                <span className="truncate grow">{siteHost(site)}</span>
                <button
                  type="button"
                  className="icon-btn sm"
                  aria-label={t("sites.copyLink")}
                  title={t("sites.copyLink")}
                  onClick={() => actions.copy(site.url, "sites.copied")}
                >
                  <Copy />
                </button>
              </span>
            </Field>
            <Field label={t("sites.site.publishedAt")}>
              {formatTime(current.finishedAt ?? current.createdAt, locale, timeZone)}
            </Field>
          </dl>
        ) : (
          <p className="dashed">
            <Globe className="dashed-icon" />
            {t("sites.site.noProduction")}
          </p>
        )}
      </Section>
      {latest && (
        <Section title={t("sites.site.latest")}>
          <DeploymentRow siteId={site.id} deployment={latest} />
        </Section>
      )}
      <Section title={t("sites.site.settings")}>
        <div className="card">
          <div className="setting">
            <div className="setting-text">
              <label htmlFor="badge" className="setting-title">
                {t("sites.site.badge")}
              </label>
              <p className="subtle sm">{t("sites.site.badgeHint")}</p>
            </div>
            <Switch
              id="badge"
              checked={!site.badgeHidden}
              disabled={state.badge.saving || (!removable && !site.badgeHidden)}
              onChange={actions.setBadgeVisible}
            />
          </div>
          {state.badge.error && <p className="card-foot danger">{t(state.badge.error)}</p>}
          {!removable && state.usage && (
            <p className="card-foot">
              <Sparkles className="foot-icon" />
              <span className="tag">{state.usage.plan}</span>
              <span>{t("sites.site.badgeLocked")}</span>
            </p>
          )}
        </div>
      </Section>
    </div>
  );
}

function DeploymentList({
  site,
  deployments,
}: {
  site: Site;
  deployments: Page<Deployment> | undefined;
}) {
  const { t, actions } = useView();
  if (!deployments) return <Loading />;
  if (deployments.items.length === 0)
    return <p className="dashed">{t("sites.deployment.empty")}</p>;
  return (
    <div className="stack-2">
      <ul className="cards">
        {deployments.items.map((deployment) => (
          <li key={deployment.id}>
            <DeploymentRow siteId={site.id} deployment={deployment} />
          </li>
        ))}
      </ul>
      {deployments.nextCursor && (
        <button type="button" className="btn ghost center" onClick={actions.loadMoreDeployments}>
          {t("sites.loadMore")}
        </button>
      )}
    </div>
  );
}

/** 部署以发起时间为标题；部署 ID 对用户没有意义，面板不显示（菜单里的日志命令仍带它）。 */
function DeploymentRow({ siteId, deployment }: { siteId: string; deployment: Deployment }) {
  const { t, locale, timeZone, actions } = useView();
  const phase = deploymentPhase(deployment);
  return (
    <button
      type="button"
      className="card row-card"
      onClick={() => actions.navigate({ page: "deployment", siteId, deploymentId: deployment.id })}
    >
      <PhaseIcon phase={phase} />
      <span className="row-card-text">
        <span className="row gap-2 wrap-row">
          <span className="strong truncate">
            {formatTime(deployment.createdAt, locale, timeZone)}
          </span>
          {deployment.isCurrent && <span className="tag">{t("sites.deployment.current")}</span>}
        </span>
        <Meta>
          <StatusLabel phase={phase} bare />
          <span>{formatBytes(deployment.artifactSize)}</span>
        </Meta>
      </span>
      <ChevronRight className="chevron" />
    </button>
  );
}

function RenameDialog({ site, rename }: { site: Site; rename: NonNullable<ViewState["rename"]> }) {
  const { t, actions } = useView();
  const [draft, setDraft] = useState(site.name);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && actions.cancelRename();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [actions]);
  return (
    <div
      className="overlay"
      onMouseDown={(event) => event.target === event.currentTarget && actions.cancelRename()}
    >
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-title"
        onSubmit={(event) => {
          event.preventDefault();
          actions.saveRename(draft);
        }}
      >
        <div className="stack-1">
          <h2 id="rename-title">{t("sites.site.rename")}</h2>
          <p className="subtle sm">{t("sites.site.renameHint")}</p>
        </div>
        <div className="stack-2">
          <label htmlFor="rename" className="field-label">
            {t("sites.site.name")}
          </label>
          <input
            id="rename"
            className="input"
            autoFocus
            maxLength={100}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          {rename.error ? (
            <p className="danger sm">{t(rename.error)}</p>
          ) : (
            <p className="row gap-1 subtle sm">
              <Globe className="inline-icon" />
              <span className="truncate">{siteHost(site)}</span>
            </p>
          )}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn ghost lg" onClick={actions.cancelRename}>
            {t("sites.cancel")}
          </button>
          <button
            type="submit"
            className="btn primary lg"
            disabled={rename.saving || !draft.trim()}
          >
            {rename.saving && <LoaderCircle className="spin" />}
            {t("sites.save")}
          </button>
        </div>
      </form>
    </div>
  );
}
