import {
    App,
    applyDocumentTheme,
    applyHostFonts,
    applyHostStyleVariables
} from "@modelcontextprotocol/ext-apps";
import "./mcp-app.css";

const root = document.getElementById("app");

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

function listItems(items, emptyText, renderItem) {
    if (!items?.length) {
        return `<p class="empty">${escapeHtml(emptyText)}</p>`;
    }
    return items.map(renderItem).join("");
}

function renderSummary(summary) {
    const totals = summary.totals ?? {};
    root.innerHTML = `
        <header class="header">
            <div>
                <h1>Product Care Summary</h1>
                <p>Checked on ${escapeHtml(summary.date ?? "today")}</p>
            </div>
        </header>
        <section class="totals">
            <div class="stat"><strong>${escapeHtml(totals.products ?? 0)}</strong><span>Products</span></div>
            <div class="stat"><strong>${escapeHtml(totals.expiringWarranties ?? 0)}</strong><span>Warranties</span></div>
            <div class="stat"><strong>${escapeHtml(totals.openServiceRequests ?? 0)}</strong><span>Open requests</span></div>
            <div class="stat"><strong>${escapeHtml(totals.upcomingAppointments ?? 0)}</strong><span>Appointments</span></div>
            <div class="stat"><strong>${escapeHtml(totals.maintenanceDue ?? 0)}</strong><span>Maintenance</span></div>
        </section>
        <p class="spoken">${escapeHtml(summary.spokenSummary ?? "")}</p>
        <section class="section">
            <h2>Expiring warranties</h2>
            ${listItems(summary.expiringWarranties, "No warranties expiring soon.", (item) => `
                <article class="item warning">
                    <div class="title">${escapeHtml(item.product ?? item.name ?? "Product")}</div>
                    <p>${escapeHtml(item.daysRemaining ?? item.daysUntilExpiry ?? "?")} days remaining · ${escapeHtml(item.warrantyExpiryDate ?? "")}</p>
                </article>
            `)}
        </section>
        <section class="section">
            <h2>Open service requests</h2>
            ${listItems(summary.openServiceRequests, "No open service requests.", (item) => `
                <article class="item">
                    <div class="title">#${escapeHtml(item.id)} · ${escapeHtml(item.productName ?? item.product ?? "Product")}</div>
                    <p>${escapeHtml(item.status ?? "")} · ${escapeHtml(item.description ?? item.issue ?? "")}</p>
                </article>
            `)}
        </section>
        <section class="section">
            <h2>Upcoming appointments</h2>
            ${listItems(summary.upcomingAppointments, "No upcoming appointments.", (item) => `
                <article class="item">
                    <div class="title">${escapeHtml(item.productName ?? item.product ?? "Product")}</div>
                    <p>${escapeHtml(item.date ?? "")} at ${escapeHtml(item.time ?? "")} · ${escapeHtml(item.notes ?? item.issue ?? "")}</p>
                </article>
            `)}
        </section>
        <section class="section">
            <h2>Maintenance due</h2>
            ${listItems(summary.maintenanceDue, "No maintenance due.", (item) => `
                <article class="item ${Number(item.daysUntilDue) < 0 ? "overdue" : "warning"}">
                    <div class="title">${escapeHtml(item.task ?? "Task")} · ${escapeHtml(item.productName ?? item.product ?? "Product")}</div>
                    <p>${Number(item.daysUntilDue) < 0 ? "Overdue" : "Due soon"} · ${escapeHtml(item.nextDueDate ?? "")}</p>
                </article>
            `)}
        </section>
    `;
}

function showStatus(message, isError = false) {
    root.innerHTML = `<p class="status${isError ? " error" : ""}">${escapeHtml(message)}</p>`;
}

function applyHostContext(ctx) {
    if (!ctx) return;
    if (ctx.theme) applyDocumentTheme(ctx.theme);
    if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
    if (ctx.safeAreaInsets) {
        const { top, right, bottom, left } = ctx.safeAreaInsets;
        document.body.style.padding = `${top}px ${right}px ${bottom}px ${left}px`;
    }
}

const app = new App({ name: "Product Care Summary", version: "1.0.0" });

app.onteardown = async () => ({});

app.ontoolinput = () => {
    showStatus("Loading care summary…");
};

app.ontoolresult = (result) => {
    const summary = result?.structuredContent;
    if (result?.isError) {
        showStatus("The care summary could not be loaded.", true);
        return;
    }
    if (!summary || summary.error) {
        showStatus(summary?.details ?? summary?.error ?? "No care summary data was returned.", true);
        return;
    }
    renderSummary(summary);
};

app.onhostcontextchanged = applyHostContext;

app.connect().then(() => {
    applyHostContext(app.getHostContext());
}).catch((error) => {
    showStatus(error?.message ?? "Could not connect to the host.", true);
});
