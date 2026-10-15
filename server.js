import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { supabase } from "./supabase.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.MCP_API_KEY || "";
const TIME_ZONE = process.env.APP_TIME_ZONE || "Asia/Kolkata";
const SLOT_TIMES = ["10:00", "14:00", "16:00"];
const CARE_SUMMARY_UI_URI = "ui://get_care_summary/mcp-app.html";
const CARE_SUMMARY_HTML_PATH = path.join(import.meta.dirname, "dist", "mcp-app.html");

const supportLinks = {
    lg: "https://www.lg.com/in/support",
    samsung: "https://www.samsung.com/in/support/",
    dell: "https://www.dell.com/support/home/en-in",
    hp: "https://support.hp.com/in-en",
    lenovo: "https://support.lenovo.com/in/en",
    sony: "https://www.sony.co.in/electronics/support"
};
// ---------------------------------------------------------------------------
// HTTP app + authentication
// ---------------------------------------------------------------------------
const app = express();
// CORS so the browser-based MCP Apps host (localhost:8080) can call this server.
// This must come BEFORE the API-key check, because the browser sends an OPTIONS
// preflight request that carries no key.
const ALLOWED_ORIGINS = ["http://localhost:8080", "http://127.0.0.1:8080"];
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        res.setHeader(
            "Access-Control-Allow-Headers",
            "Content-Type, Accept, Authorization, X-API-Key, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID"
        );
        res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    }
    // Answer the browser's preflight check immediately.
    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }
    next();
});

app.use(express.json());

const rpcError = (code, message) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

function safeEqual(a, b) {
    const ha = crypto.createHash("sha256").update(a).digest();
    const hb = crypto.createHash("sha256").update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

// Accepts "Authorization: Bearer <key>" or "x-api-key: <key>".
function requireApiKey(req, res, next) {
    if (!API_KEY) {
        if (process.env.NODE_ENV === "production") {
            return res.status(500).json(rpcError(-32603, "Server authentication is not configured."));
        }
        return next(); // local development without a key
    }

    const authHeader = req.get("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : (req.get("x-api-key") ?? "").trim();

    if (!token || !safeEqual(token, API_KEY)) {
        return res.status(401).json(rpcError(-32001, "Unauthorized"));
    }
    next();
}

app.use("/mcp", requireApiKey);

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------
function result(data) {
    return {
        content: [{
            type: "text",
            text: typeof data === "string" ? data : JSON.stringify(data, null, 2)
        }]
    };
}

function safe(handler) {
    return async (args) => {
        try {
            return await handler(args);
        } catch (error) {
            console.error("Product Care Assistant tool error:", error?.message ?? error);
            return result({
                error: "The operation could not be completed.",
                details: error?.message ?? String(error)
            });
        }
    };
}

// Today's date (YYYY-MM-DD) in the configured time zone, so "today" is correct in India.
function todayISO() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(new Date());
}

function daysBetween(fromISO, toISO) {
    const from = Date.parse(`${fromISO}T00:00:00.000Z`);
    const to = Date.parse(`${toISO}T00:00:00.000Z`);
    return Math.round((to - from) / 86400000);
}

function daysUntil(dateString) {
    return daysBetween(todayISO(), dateString);
}

// Adds whole months and clamps to the last day of the month (31 Jan + 1 month = 28/29 Feb).
function addMonths(dateString, months) {
    const date = new Date(`${dateString}T00:00:00.000Z`);
    const day = date.getUTCDate();

    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + months);

    const lastDay = new Date(Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        0
    )).getUTCDate();

    date.setUTCDate(Math.min(day, lastDay));
    return date.toISOString().slice(0, 10);
}

// Postgres "time" columns return "10:00:00"; normalise to "10:00".
function normalizeTime(value) {
    return value == null ? value : String(value).slice(0, 5);
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------
function mapProduct(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        brand: row.brand,
        category: row.category ?? null,
        purchaseDate: row.purchase_date,
        price: Number(row.purchase_price ?? 0),
        warrantyMonths: row.warranty_months,
        serialNumber: row.serial_number ?? null,
        modelNumber: row.model_number ?? null,
        notes: row.notes ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function mapServiceRequest(row, product = null) {
    if (!row) return null;
    return {
        id: row.id,
        productId: row.product_id,
        ...(product ? { productName: product.name, brand: product.brand } : {}),
        issue: row.description,
        status: row.status,
        priority: row.priority,
        requestType: row.request_type,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function mapHistory(row) {
    if (!row) return null;
    const details = row.details ?? {};
    return {
        ...details,
        id: row.id,
        productId: row.product_id,
        date: details.date ?? row.created_at,
        type: row.history_type,
        notes: row.notes,
        createdAt: row.created_at,
        serviceRequestId: row.service_request_id ?? null
    };
}

function mapAppointment(row, product = null) {
    if (!row) return null;
    return {
        id: row.id,
        productId: row.product_id,
        ...(product ? { productName: product.name, brand: product.brand } : {}),
        date: row.appointment_date,
        time: normalizeTime(row.appointment_time),
        issue: row.notes ?? "",
        status: row.status,
        serviceRequestId: row.service_request_id ?? null,
        createdAt: row.created_at
    };
}

function mapMaintenance(row, product) {
    const baseDate = row.last_done_date ?? product.purchaseDate;
    const nextDueDate = addMonths(baseDate, row.interval_months);
    return {
        id: row.id,
        productId: row.product_id,
        productName: product.name,
        brand: product.brand,
        task: row.task,
        intervalMonths: row.interval_months,
        lastDoneDate: row.last_done_date ?? null,
        nextDueDate,
        daysUntilDue: daysUntil(nextDueDate)
    };
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------
async function findProduct(productId) {
    const { data, error } = await supabase
        .from("products")
        .select("*")
        .eq("id", productId)
        .maybeSingle();

    if (error) throw error;
    return mapProduct(data);
}


async function getAllProducts() {
    console.log("Testing Supabase products query...");

    const { data, error } = await supabase
        .from("products")
        .select("*")
        .order("id", { ascending: true });

    if (error) {
        console.error("Supabase query error:", error);
        throw error;
    }

    console.log("Supabase query succeeded. Rows:", data?.length ?? 0);
    return (data ?? []).map(mapProduct);
}


async function getProductMap() {
    const products = await getAllProducts();
    return new Map(products.map(product => [product.id, product]));
}

async function recordHistory(productId, type, notes, extra = {}, serviceRequestId = null) {
    const { data, error } = await supabase
        .from("service_history")
        .insert({
            product_id: productId,
            service_request_id: serviceRequestId,
            history_type: type,
            notes,
            details: extra
        })
        .select("*")
        .single();

    if (error) throw error;
    return mapHistory(data);
}

// ---------------------------------------------------------------------------
// Warranty + maintenance logic
// ---------------------------------------------------------------------------
function calculateExpiry(purchaseDate, warrantyMonths) {
    return addMonths(purchaseDate, warrantyMonths);
}

function warrantyInfo(product) {
    const expiry = calculateExpiry(product.purchaseDate, product.warrantyMonths);
    const daysRemaining = daysUntil(expiry);

    return {
        productId: product.id,
        product: product.name,
        brand: product.brand,
        purchaseDate: product.purchaseDate,
        warrantyExpiryDate: expiry,
        warrantyStatus: daysRemaining >= 0 ? "Active" : "Expired",
        daysRemaining
    };
}

async function getMaintenanceDue({ daysAhead, productId, productMap }) {
    let query = supabase.from("maintenance_tasks").select("*").order("id", { ascending: true });
    if (productId !== undefined) query = query.eq("product_id", productId);

    const { data, error } = await query;
    if (error) throw error;

    return (data ?? [])
        .map(row => {
            const product = productMap.get(row.product_id);
            return product ? mapMaintenance(row, product) : null;
        })
        .filter(task => task && task.daysUntilDue <= daysAhead) // includes overdue (negative)
        .sort((a, b) => a.daysUntilDue - b.daysUntilDue);
}

// ---------------------------------------------------------------------------
// Troubleshooting knowledge base (category-aware)
// ---------------------------------------------------------------------------
const CATEGORY_PATTERNS = [
    ["air_conditioner", /air\s*conditioner|\bac\b|split\s*ac|window\s*ac/],
    ["refrigerator", /refrigerator|fridge/],
    ["washing_machine", /washing\s*machine|washer/],
    ["television", /\btv\b|television/],
    ["laptop", /laptop|notebook|macbook/],
    ["phone", /smartphone|\bphone\b|mobile/],
    ["water_purifier", /water\s*purifier|\bro\b/]
];

function inferCategory(product, problem = "") {
    const declared = (product.category ?? "").toLowerCase().trim().replace(/\s+/g, "_");
    if (declared && TROUBLESHOOTING[declared]) return declared;

    for (const text of [product.category ?? "", product.name, problem]) {
        const lower = text.toLowerCase();
        for (const [category, pattern] of CATEGORY_PATTERNS) {
            if (pattern.test(lower)) return category;
        }
    }
    return "general";
}

const TROUBLESHOOTING = {
    air_conditioner: {
        generic: [
            "Check the power supply and the MCB/switch.",
            "Confirm the remote batteries and that the mode and temperature are set correctly.",
            "Clean the air filter as described in the manual."
        ],
        symptoms: [
            [/cool|warm|hot/, [
                "Set the mode to Cool and the temperature well below room temperature.",
                "Clean the air filter and keep doors and windows closed.",
                "Make sure nothing blocks the outdoor unit's airflow."
            ]],
            [/leak|drip|water/, [
                "Check whether the drain pipe is blocked or kinked.",
                "Clean the filter; a clogged filter can cause dripping.",
                "Check that the indoor unit is mounted level."
            ]],
            [/noise|sound|rattl/, [
                "Check for loose panels or objects touching the outdoor unit.",
                "Clean the filter and vents.",
                "If a grinding or banging noise continues, stop using it and contact service."
            ]]
        ]
    },
    refrigerator: {
        generic: [
            "Check the power connection and the thermostat setting.",
            "Make sure the door closes fully and the seals are clean.",
            "Do not overload the shelves; air must circulate."
        ],
        symptoms: [
            [/cool|warm|not cold/, [
                "Set the thermostat to a colder setting and wait several hours.",
                "Check that the door seals close tightly.",
                "Keep the back and sides ventilated; dust off the condenser if the manual allows."
            ]],
            [/ice|frost/, [
                "Check the door seal and avoid leaving the door open.",
                "Defrost if the model requires manual defrosting.",
                "Avoid putting hot food inside."
            ]],
            [/leak|water/, [
                "Check the defrost drain for blockage.",
                "Check that the unit sits level.",
                "Check the water inlet if it has a dispenser."
            ]]
        ]
    },
    washing_machine: {
        generic: [
            "Check the power and the water supply tap.",
            "Make sure the door or lid is closed properly.",
            "Do not exceed the recommended load."
        ],
        symptoms: [
            [/drain|water.*(stay|left)/, [
                "Check the drain hose for kinks.",
                "Clean the drain filter as shown in the manual.",
                "Check that the drain hose height is correct."
            ]],
            [/spin|vibrat|shak|noise/, [
                "Rebalance the load; do not wash a single heavy item.",
                "Check that the machine is level and the transport bolts are removed.",
                "If the noise is grinding or banging, stop and contact service."
            ]]
        ]
    },
    television: {
        generic: [
            "Check the power cable and the input source.",
            "Replace the remote batteries.",
            "Unplug the TV for 60 seconds and plug it back in."
        ],
        symptoms: [
            [/black|no display|no picture|blank/, [
                "Check the input/source setting and the cable connection.",
                "Unplug the TV for 60 seconds and try again.",
                "If sound works but there is no picture, contact service."
            ]],
            [/sound|audio|volume/, [
                "Check mute and the audio output setting.",
                "Try a different input source.",
                "Reset the audio settings in the menu."
            ]]
        ]
    },
    laptop: {
        generic: [
            "Check the power outlet and use a compatible charger.",
            "Look for the charging indicator.",
            "Disconnect external accessories and try again."
        ],
        symptoms: [
            [/turn|boot|start|power on|dead/, [
                "Hold the power button for 15 to 20 seconds, then try again.",
                "Try a different outlet and a compatible charger.",
                "Remove external devices before powering on."
            ]],
            [/heat|hot|fan/, [
                "Use the laptop on a hard, flat surface.",
                "Check for dust at the vents.",
                "Close heavy background programs."
            ]],
            [/slow|lag|hang|freez/, [
                "Restart and check for pending updates.",
                "Close heavy background programs.",
                "Check available disk space."
            ]]
        ]
    },
    phone: {
        generic: [
            "Restart the phone.",
            "Check for software updates.",
            "Contact manufacturer support if the issue persists."
        ],
        symptoms: [
            [/battery|drain/, [
                "Check battery usage in settings for apps using the most power.",
                "Lower screen brightness and update the apps and system.",
                "If the battery drops very fast or swells, stop using it and contact service."
            ]],
            [/charg/, [
                "Try a different cable and charger.",
                "Clean the charging port gently with a dry, non-metal tool.",
                "Try a different outlet."
            ]]
        ]
    },
    water_purifier: {
        generic: [
            "Check the power and the water inlet supply.",
            "Check whether the filter or membrane replacement is due.",
            "Contact the manufacturer's service for filter changes."
        ],
        symptoms: [
            [/flow|slow|no water|low/, [
                "Check that the inlet tap is open and the supply pressure is normal.",
                "Check whether the filter replacement is overdue.",
                "Check hoses for kinks."
            ]],
            [/taste|smell|odor|odour/, [
                "Check whether the filter or membrane change is due.",
                "Flush the system as the manual describes.",
                "Contact service for a water quality check."
            ]]
        ]
    },
    general: {
        generic: [
            "Check the product manual for this symptom.",
            "Record any error messages.",
            "Contact manufacturer support if the issue persists."
        ],
        symptoms: []
    }
};

const COMMON_SYMPTOMS = [
    [/wifi|wi-fi|internet|network/, [
        "Check whether Wi-Fi is enabled on the device.",
        "Check whether other devices can connect to the same network.",
        "Restart your router if appropriate."
    ]],
    [/battery|charging/, [
        "Check the charger and cable for visible damage.",
        "Try a compatible charger and a known-working outlet.",
        "Consult the manufacturer's charging guidance."
    ]]
];

function pickTroubleshootingSteps(category, problem) {
    const issue = problem.toLowerCase();
    const entry = TROUBLESHOOTING[category] ?? TROUBLESHOOTING.general;

    for (const [pattern, steps] of [...entry.symptoms, ...COMMON_SYMPTOMS]) {
        if (pattern.test(issue)) return steps;
    }
    return entry.generic;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
function createMcpServer() {
    const server = new McpServer({
        name: "product-care-assistant",
        version: "4.0.0"
    });

    // 1. Register a product.
    server.tool(
        "add_product",
        "Register a purchased product and its warranty details.",
        {
            name: z.string().min(1),
            brand: z.string().min(1),
            purchaseDate: z.string().date(),
            price: z.number().nonnegative(),
            warrantyMonths: z.number().int().nonnegative(),
            category: z.string().min(1).optional(),
            serialNumber: z.string().min(1).optional(),
            modelNumber: z.string().min(1).optional(),
            notes: z.string().optional()
        },
        safe(async ({ name, brand, purchaseDate, price, warrantyMonths, category, serialNumber, modelNumber, notes }) => {
            const row = {
                name,
                brand,
                purchase_date: purchaseDate,
                purchase_price: price,
                warranty_months: warrantyMonths
            };
            if (category !== undefined) row.category = category;
            if (serialNumber !== undefined) row.serial_number = serialNumber;
            if (modelNumber !== undefined) row.model_number = modelNumber;
            if (notes !== undefined) row.notes = notes;

            const { data, error } = await supabase
                .from("products")
                .insert(row)
                .select("*")
                .single();

            if (error) throw error;
            return result({
                message: "Product registered and saved to Supabase.",
                product: mapProduct(data)
            });
        })
    );

    // 2. List products.
    server.tool(
        "get_products",
        "List all registered products.",
        {},
        safe(async () => {
            const products = await getAllProducts();
            return result({ count: products.length, products });
        })
    );

    // 3. Find products by name, brand or category.
    server.tool(
        "find_product",
        "Search registered products by product name, brand or category.",
        { searchTerm: z.string().min(1) },
        safe(async ({ searchTerm }) => {
            const term = searchTerm.toLowerCase();
            const products = (await getAllProducts()).filter(product =>
                product.name.toLowerCase().includes(term) ||
                product.brand.toLowerCase().includes(term) ||
                (product.category ?? "").toLowerCase().includes(term)
            );
            return result({ count: products.length, products });
        })
    );

    // 4. Get product details.
    server.tool(
        "get_product_details",
        "Get all stored details of a registered product.",
        { productId: z.number().int().positive() },
        safe(async ({ productId }) => {
            const product = await findProduct(productId);
            if (!product) return result("Product not found.");
            return result({ product, warranty: warrantyInfo(product) });
        })
    );

    // 5. Update product details.
    server.tool(
        "update_product",
        "Update the stored details of a registered product.",
        {
            productId: z.number().int().positive(),
            name: z.string().min(1).optional(),
            brand: z.string().min(1).optional(),
            purchaseDate: z.string().date().optional(),
            price: z.number().nonnegative().optional(),
            warrantyMonths: z.number().int().nonnegative().optional(),
            category: z.string().min(1).optional(),
            serialNumber: z.string().min(1).optional(),
            modelNumber: z.string().min(1).optional(),
            notes: z.string().optional()
        },
        safe(async ({ productId, ...changes }) => {
            const current = await findProduct(productId);
            if (!current) return result("Product not found.");

            const update = {};
            if (changes.name !== undefined) update.name = changes.name;
            if (changes.brand !== undefined) update.brand = changes.brand;
            if (changes.purchaseDate !== undefined) update.purchase_date = changes.purchaseDate;
            if (changes.price !== undefined) update.purchase_price = changes.price;
            if (changes.warrantyMonths !== undefined) update.warranty_months = changes.warrantyMonths;
            if (changes.category !== undefined) update.category = changes.category;
            if (changes.serialNumber !== undefined) update.serial_number = changes.serialNumber;
            if (changes.modelNumber !== undefined) update.model_number = changes.modelNumber;
            if (changes.notes !== undefined) update.notes = changes.notes;

            if (Object.keys(update).length === 0) {
                return result({ message: "No changes supplied.", product: current });
            }

            update.updated_at = new Date().toISOString();
            const { data, error } = await supabase
                .from("products")
                .update(update)
                .eq("id", productId)
                .select("*")
                .single();

            if (error) throw error;
            return result({ message: "Product updated in Supabase.", product: mapProduct(data) });
        })
    );

    // 6. Delete product after explicit approval.
    // Refuses deletion while service records exist, to preserve history.
    // Maintenance tasks are removed automatically (ON DELETE CASCADE).
    server.tool(
        "delete_product",
        "Delete a registered product after the user has confirmed the deletion.",
        {
            productId: z.number().int().positive(),
            userConfirmed: z.boolean()
        },
        safe(async ({ productId, userConfirmed }) => {
            const product = await findProduct(productId);
            if (!product) return result("Product not found.");

            if (!userConfirmed) {
                return result({
                    deleted: false,
                    message: "Ask the user to confirm deletion before trying again."
                });
            }

            const relatedTables = ["service_requests", "service_history", "appointments"];
            for (const table of relatedTables) {
                const { data, error } = await supabase
                    .from(table)
                    .select("id")
                    .eq("product_id", productId)
                    .limit(1);
                if (error) throw error;
                if (data?.length) {
                    return result({
                        deleted: false,
                        message: `This product has related records in ${table}. Deletion was stopped to preserve service records. Archive or handle those records first.`
                    });
                }
            }

            const { data, error } = await supabase
                .from("products")
                .delete()
                .eq("id", productId)
                .select("*")
                .maybeSingle();

            if (error) throw error;
            if (!data) return result("Product was not deleted or could not be found.");

            return result({ deleted: true, product: mapProduct(data), message: "Product deleted." });
        })
    );

    // 7. Check warranty.
    server.tool(
        "check_warranty",
        "Check the warranty status and expiry date of a product.",
        { productId: z.number().int().positive() },
        safe(async ({ productId }) => {
            const product = await findProduct(productId);
            if (!product) return result("Product not found.");
            return result(warrantyInfo(product));
        })
    );

    // 8. Find warranties expiring soon.
    server.tool(
        "get_expiring_warranties",
        "Find registered products whose warranties expire within the requested number of days.",
        { daysAhead: z.number().int().min(0).max(365).default(30) },
        safe(async ({ daysAhead }) => {
            const products = await getAllProducts();
            const alerts = products
                .map(warrantyInfo)
                .filter(info => info.warrantyStatus === "Active" && info.daysRemaining <= daysAhead)
                .sort((a, b) => a.daysRemaining - b.daysRemaining);

            return result({
                checkedAt: new Date().toISOString(),
                daysAhead,
                count: alerts.length,
                alerts
            });
        })
    );

    // 9. Estimate warranty coverage.
    server.tool(
        "check_warranty_coverage",
        "Give a preliminary warranty coverage estimate; the manufacturer makes the actual decision.",
        {
            productId: z.number().int().positive(),
            issueType: z.string().min(1)
        },
        safe(async ({ productId, issueType }) => {
            const product = await findProduct(productId);
            if (!product) return result("Product not found.");

            const warranty = warrantyInfo(product);
            const issue = issueType.toLowerCase();
            let assessment;

            if (/physical damage|accidental damage|broken screen|water damage/.test(issue)) {
                assessment = "Likely excluded from a standard warranty";
            } else if (warranty.warrantyStatus === "Expired") {
                assessment = "Standard warranty has expired";
            } else {
                assessment = "Potentially covered; manufacturer confirmation is required";
            }

            return result({
                product: product.name,
                issueType,
                warrantyStatus: warranty.warrantyStatus,
                warrantyExpiryDate: warranty.warrantyExpiryDate,
                assessment,
                disclaimer: "This is an estimate, not an official coverage decision."
            });
        })
    );

    // 10. Troubleshooting, now aware of the product category and the symptom.
    server.tool(
        "troubleshoot_product",
        "Suggest basic troubleshooting steps for a registered product, based on its category and the problem described.",
        {
            productId: z.number().int().positive(),
            problem: z.string().min(1)
        },
        safe(async ({ productId, problem }) => {
            const product = await findProduct(productId);
            if (!product) return result("Product not found.");

            const category = inferCategory(product, problem);
            const suggestions = pickTroubleshootingSteps(category, problem);

            return result({
                product: product.name,
                category,
                problem,
                suggestions,
                safetyNote: "Stop using equipment that appears unsafe. Do not attempt hazardous repairs."
            });
        })
    );

    // 11. Compare recorded repair costs against purchase price.
    server.tool(
        "repair_or_replace_advice",
        "Compare recorded repair costs with purchase price and provide a transparent preliminary repair-or-replace assessment.",
        { productId: z.number().int().positive() },
        safe(async ({ productId }) => {
            const product = await findProduct(productId);
            if (!product) return result("Product not found.");

            const { data, error } = await supabase
                .from("service_history")
                .select("*")
                .eq("product_id", productId)
                .eq("history_type", "Service visit");
            if (error) throw error;

            const visits = (data ?? []).map(mapHistory).filter(visit => typeof visit.cost === "number");
            const repairCosts = visits.reduce((total, visit) => total + visit.cost, 0);
            const ratio = product.price > 0 ? repairCosts / product.price : null;
            let recommendation;

            if (ratio === null) {
                recommendation = "Purchase price is zero; a cost comparison is unavailable.";
            } else if (ratio >= 0.5) {
                recommendation = "Consider comparing replacement options with another repair estimate.";
            } else {
                recommendation = "Repair may be worth considering, depending on the next repair quote and product condition.";
            }

            return result({
                product: product.name,
                purchasePrice: product.price,
                recordedRepairCosts: repairCosts,
                repairCostAsPercentageOfPurchasePrice: ratio === null ? null : Number((ratio * 100).toFixed(1)),
                recordedVisits: visits.length,
                recommendation,
                disclaimer: "This is a simple cost comparison, not a prediction of product lifespan. Energy use, safety, age, repair quotes and replacement cost also matter."
            });
        })
    );

    // 12. Draft a warranty claim for the user to review.
    server.tool(
        "draft_warranty_claim",
        "Draft a warranty claim message for the user to review and send.",
        {
            productId: z.number().int().positive(),
            issue: z.string().min(1),
            customerName: z.string().min(1).optional(),
            extraDetails: z.string().optional()
        },
        safe(async ({ productId, issue, customerName, extraDetails }) => {
            const product = await findProduct(productId);
            if (!product) return result("Product not found.");

            const warranty = warrantyInfo(product);
            const draft = [
                `Subject: Warranty Assistance Request - ${product.name}`,
                "",
                `Dear ${product.brand} Support Team,`,
                "",
                `I would like to request assistance with my ${product.name}.`,
                `Brand: ${product.brand}`,
                product.modelNumber ? `Model number: ${product.modelNumber}` : null,
                product.serialNumber ? `Serial number: ${product.serialNumber}` : null,
                `Purchase date: ${product.purchaseDate}`,
                `Recorded warranty duration: ${product.warrantyMonths} months`,
                `Calculated warranty expiry: ${warranty.warrantyExpiryDate}`,
                `Recorded warranty status: ${warranty.warrantyStatus}`,
                `Reported issue: ${issue}`,
                extraDetails ? `Additional details: ${extraDetails}` : null,
                "",
                "Please confirm whether this issue is covered under the applicable warranty and advise me on the next steps.",
                "",
                "I can provide the purchase invoice and any other required documentation.",
                "",
                `Regards,\n${customerName || "[Your name]"}`
            ].filter(line => line !== null) // drop skipped optional lines, keep intentional blank lines
                .join("\n");

            return result({
                message: "Draft prepared. Review it before sending.",
                recipient: `${product.brand} Support`,
                officialSupportUrl: supportLinks[product.brand.trim().toLowerCase()] ?? null,
                warrantyStatus: warranty.warrantyStatus,
                draft
            });
        })
    );

    // 13. Create a service request after explicit approval.
    server.tool(
        "create_service_request",
        "Create a demo service request only after the user explicitly approves.",
        {
            productId: z.number().int().positive(),
            issue: z.string().min(1),
            userConfirmed: z.boolean()
        },
        safe(async ({ productId, issue, userConfirmed }) => {
            const product = await findProduct(productId);
            if (!product) return result("Product not found.");

            if (!userConfirmed) {
                return result({
                    created: false,
                    message: "No request was created. Ask the user for explicit approval."
                });
            }

            const { data, error } = await supabase
                .from("service_requests")
                .insert({
                    product_id: productId,
                    description: issue,
                    status: "Open",
                    priority: "normal",
                    request_type: "repair"
                })
                .select("*")
                .single();
            if (error) throw error;

            const request = mapServiceRequest(data, product);
            await recordHistory(
                productId,
                "Service request",
                `Request #${request.id}: ${issue}`,
                {},
                request.id
            );

            return result({
                message: "Demo service request saved to Supabase.",
                request,
                note: "This is not a real manufacturer booking."
            });
        })
    );

    // 14. List service requests (single product lookup instead of one query per row).
    server.tool(
        "get_service_requests",
        "List all service requests or filter by product ID.",
        { productId: z.number().int().positive().optional() },
        safe(async ({ productId }) => {
            let query = supabase
                .from("service_requests")
                .select("*")
                .order("id", { ascending: true });

            if (productId !== undefined) query = query.eq("product_id", productId);

            const { data, error } = await query;
            if (error) throw error;

            const productMap = await getProductMap();
            const requests = (data ?? []).map(row =>
                mapServiceRequest(row, productMap.get(row.product_id) ?? null)
            );

            return result({ count: requests.length, serviceRequests: requests });
        })
    );

    // 15. Change request status after explicit approval.
    server.tool(
        "update_service_request_status",
        "Update a demo service request's status after checking with the user.",
        {
            requestId: z.number().int().positive(),
            status: z.enum(["Open", "In Progress", "Completed", "Cancelled"]),
            userConfirmed: z.boolean()
        },
        safe(async ({ requestId, status, userConfirmed }) => {
            const { data: existing, error: findError } = await supabase
                .from("service_requests")
                .select("*")
                .eq("id", requestId)
                .maybeSingle();
            if (findError) throw findError;
            if (!existing) return result("Service request not found.");

            if (!userConfirmed) {
                return result({
                    updated: false,
                    message: "Ask the user to confirm this status change."
                });
            }

            const { data, error } = await supabase
                .from("service_requests")
                .update({ status, updated_at: new Date().toISOString() })
                .eq("id", requestId)
                .select("*")
                .single();
            if (error) throw error;

            await recordHistory(
                data.product_id,
                "Request status updated",
                `Request #${requestId} changed to ${status}`,
                {},
                requestId
            );

            const product = await findProduct(data.product_id);
            return result({
                message: "Service request status updated in Supabase.",
                request: mapServiceRequest(data, product)
            });
        })
    );

    // 16. Retrieve service history.
    server.tool(
        "get_service_history",
        "Retrieve service history, optionally filtered by product ID.",
        { productId: z.number().int().positive().optional() },
        safe(async ({ productId }) => {
            let query = supabase
                .from("service_history")
                .select("*")
                .order("id", { ascending: true });
            if (productId !== undefined) query = query.eq("product_id", productId);

            const { data, error } = await query;
            if (error) throw error;

            const history = (data ?? []).map(mapHistory);
            return result({ count: history.length, serviceHistory: history });
        })
    );

    // 17. Record a completed service visit. Date and cost are stored in JSONB.
    server.tool(
        "record_service_visit",
        "Record a service visit that has actually occurred.",
        {
            productId: z.number().int().positive(),
            date: z.string().date(),
            notes: z.string().min(1),
            cost: z.number().nonnegative()
        },
        safe(async ({ productId, date, notes, cost }) => {
            const product = await findProduct(productId);
            if (!product) return result("Product not found.");

            const visit = await recordHistory(
                productId,
                "Service visit",
                notes,
                { date, cost, productName: product.name }
            );

            return result({ message: "Service visit saved to Supabase.", visit });
        })
    );

    // 18. Find available simulated appointment slots using database bookings.
    server.tool(
        "get_available_slots",
        "Return simulated service appointment slots for a future date.",
        {
            productId: z.number().int().positive(),
            date: z.string().date()
        },
        safe(async ({ productId, date }) => {
            const product = await findProduct(productId);
            if (!product) return result("Product not found.");
            if (daysUntil(date) < 0) return result("Choose today or a future date.");

            const { data, error } = await supabase
                .from("appointments")
                .select("appointment_time")
                .eq("appointment_date", date)
                .eq("status", "Booked");
            if (error) throw error;

            const occupiedTimes = new Set((data ?? []).map(row => normalizeTime(row.appointment_time)));
            const slots = SLOT_TIMES
                .filter(time => !occupiedTimes.has(time))
                .map(time => ({ date, time }));

            return result({
                product: product.name,
                date,
                slots,
                note: "These are simulated demo slots, not live manufacturer availability."
            });
        })
    );

    // 19. Book a simulated appointment after approval (race-safe via unique index).
    server.tool(
        "book_appointment",
        "Book a simulated appointment slot only after explicit user approval.",
        {
            productId: z.number().int().positive(),
            date: z.string().date(),
            time: z.enum(SLOT_TIMES),
            issue: z.string().min(1),
            userConfirmed: z.boolean()
        },
        safe(async ({ productId, date, time, issue, userConfirmed }) => {
            const product = await findProduct(productId);
            if (!product) return result("Product not found.");
            if (daysUntil(date) < 0) return result("Choose today or a future date.");

            if (!userConfirmed) {
                return result({
                    booked: false,
                    message: "No appointment was booked. Ask the user for approval first."
                });
            }

            const slotTakenMessage = {
                booked: false,
                message: "That demo slot is already booked. Check available slots again."
            };

            const { data: existing, error: checkError } = await supabase
                .from("appointments")
                .select("id")
                .eq("appointment_date", date)
                .eq("appointment_time", time)
                .eq("status", "Booked")
                .limit(1);
            if (checkError) throw checkError;
            if (existing?.length) return result(slotTakenMessage);

            const { data, error } = await supabase
                .from("appointments")
                .insert({
                    product_id: productId,
                    appointment_date: date,
                    appointment_time: time,
                    status: "Booked",
                    notes: issue
                })
                .select("*")
                .single();

            if (error) {
                // 23505 = unique violation: someone booked this slot between the check and the insert.
                if (error.code === "23505") return result(slotTakenMessage);
                throw error;
            }

            const appointment = mapAppointment(data, product);
            await recordHistory(
                productId,
                "Demo appointment",
                `Appointment #${appointment.id} for ${date} at ${time}`
            );

            return result({
                message: "Simulated appointment saved to Supabase.",
                appointment,
                note: "This booking exists only in the demo; no manufacturer has been contacted."
            });
        })
    );

    // 20. Return official manufacturer support URL.
    server.tool(
        "get_manufacturer_support",
        "Return a configured official manufacturer support page for a product.",
        { productId: z.number().int().positive() },
        safe(async ({ productId }) => {
            const product = await findProduct(productId);
            if (!product) return result("Product not found.");

            const url = supportLinks[product.brand.trim().toLowerCase()];
            return result({
                product: product.name,
                brand: product.brand,
                officialSupportUrl: url ?? null,
                message: url
                    ? "Open this official support page to review warranty terms and available service options."
                    : "No support link is configured for this brand. Find the manufacturer's official website.",
                note: "The link does not guarantee that online booking is available."
            });
        })
    );

    // 21. Health check.
    server.tool(
        "say_hello",
        "Verify that the Product Care Assistant MCP server is responding.",
        {},
        async () => result("Hello! Your Product Care Assistant MCP server is working.")
    );

    // 22. NEW: add a recurring maintenance task.
    server.tool(
        "add_maintenance_task",
        "Add a recurring maintenance task for a product, such as cleaning an AC filter every 3 months.",
        {
            productId: z.number().int().positive(),
            task: z.string().min(1),
            intervalMonths: z.number().int().min(1).max(60),
            lastDoneDate: z.string().date().optional()
        },
        safe(async ({ productId, task, intervalMonths, lastDoneDate }) => {
            const product = await findProduct(productId);
            if (!product) return result("Product not found.");

            const { data, error } = await supabase
                .from("maintenance_tasks")
                .insert({
                    product_id: productId,
                    task,
                    interval_months: intervalMonths,
                    last_done_date: lastDoneDate ?? null
                })
                .select("*")
                .single();
            if (error) throw error;

            return result({
                message: "Maintenance task saved.",
                task: mapMaintenance(data, product),
                note: lastDoneDate
                    ? undefined
                    : "No last-done date given, so the first due date is counted from the purchase date."
            });
        })
    );

    // 23. NEW: mark a maintenance task as done.
    server.tool(
        "complete_maintenance_task",
        "Record that a maintenance task was done, which resets its next due date.",
        {
            taskId: z.number().int().positive(),
            date: z.string().date().optional()
        },
        safe(async ({ taskId, date }) => {
            const { data: existing, error: findError } = await supabase
                .from("maintenance_tasks")
                .select("*")
                .eq("id", taskId)
                .maybeSingle();
            if (findError) throw findError;
            if (!existing) return result("Maintenance task not found.");

            const product = await findProduct(existing.product_id);
            if (!product) return result("Product not found.");

            const doneOn = date ?? todayISO();
            const { data, error } = await supabase
                .from("maintenance_tasks")
                .update({ last_done_date: doneOn })
                .eq("id", taskId)
                .select("*")
                .single();
            if (error) throw error;

            await recordHistory(
                product.id,
                "Maintenance",
                `${existing.task} done on ${doneOn}`,
                { date: doneOn, productName: product.name }
            );

            return result({
                message: "Maintenance recorded.",
                task: mapMaintenance(data, product)
            });
        })
    );

    // 24. NEW: maintenance that is due soon or overdue.
    server.tool(
        "get_maintenance_due",
        "List maintenance tasks that are overdue or due within the requested number of days.",
        {
            daysAhead: z.number().int().min(0).max(365).default(14),
            productId: z.number().int().positive().optional()
        },
        safe(async ({ daysAhead, productId }) => {
            const productMap = await getProductMap();
            const tasks = await getMaintenanceDue({ daysAhead, productId, productMap });
            return result({
                daysAhead,
                count: tasks.length,
                tasks: tasks.map(task => ({
                    ...task,
                    status: task.daysUntilDue < 0 ? "Overdue" : "Due soon"
                }))
            });
        })
    );

    // 25. One-call summary of everything that needs attention, with a read-only dashboard UI.
    registerAppTool(
        server,
        "get_care_summary",
        {
            title: "Care Summary",
            description: "Summarise everything needing attention across all products: expiring warranties, open service requests, upcoming appointments and maintenance due. Includes a short spoken-style summary.",
            inputSchema: {},
            _meta: { ui: { resourceUri: CARE_SUMMARY_UI_URI } }
        },
        safe(async () => {
            const today = todayISO();
            const productMap = await getProductMap();
            const products = [...productMap.values()];

            const expiringWarranties = products
                .map(warrantyInfo)
                .filter(info => info.warrantyStatus === "Active" && info.daysRemaining <= 60)
                .sort((a, b) => a.daysRemaining - b.daysRemaining);

            const { data: requestRows, error: requestError } = await supabase
                .from("service_requests")
                .select("*")
                .in("status", ["Open", "In Progress"])
                .order("id", { ascending: true });
            if (requestError) throw requestError;
            const openRequests = (requestRows ?? []).map(row =>
                mapServiceRequest(row, productMap.get(row.product_id) ?? null)
            );

            const { data: appointmentRows, error: appointmentError } = await supabase
                .from("appointments")
                .select("*")
                .eq("status", "Booked")
                .gte("appointment_date", today)
                .order("appointment_date", { ascending: true });
            if (appointmentError) throw appointmentError;
            const upcomingAppointments = (appointmentRows ?? []).map(row =>
                mapAppointment(row, productMap.get(row.product_id) ?? null)
            );

            const maintenance = await getMaintenanceDue({ daysAhead: 30, productMap });

            const spoken = [];
            if (expiringWarranties.length) {
                const first = expiringWarranties[0];
                spoken.push(
                    `${expiringWarranties.length} warrant${expiringWarranties.length === 1 ? "y expires" : "ies expire"} within 60 days, the soonest being ${first.product} in ${first.daysRemaining} days`
                );
            }
            if (openRequests.length) {
                spoken.push(`${openRequests.length} service request${openRequests.length === 1 ? " is" : "s are"} still open`);
            }
            if (upcomingAppointments.length) {
                const next = upcomingAppointments[0];
                spoken.push(`your next appointment is ${next.date} at ${next.time}`);
            }
            if (maintenance.length) {
                const overdue = maintenance.filter(task => task.daysUntilDue < 0).length;
                spoken.push(
                    `${maintenance.length} maintenance task${maintenance.length === 1 ? " needs" : "s need"} attention${overdue ? `, ${overdue} overdue` : ""}`
                );
            }

            const payload = {
                date: today,
                totals: {
                    products: products.length,
                    expiringWarranties: expiringWarranties.length,
                    openServiceRequests: openRequests.length,
                    upcomingAppointments: upcomingAppointments.length,
                    maintenanceDue: maintenance.length
                },
                expiringWarranties,
                openServiceRequests: openRequests,
                upcomingAppointments,
                maintenanceDue: maintenance,
                spokenSummary: spoken.length
                    ? `${spoken.join(". ")}.`
                    : "Everything looks fine. Nothing needs your attention right now."
            };

            return {
                ...result(payload),
                structuredContent: payload
            };
        })
    );

    registerAppResource(
        server,
        "Care Summary UI",
        CARE_SUMMARY_UI_URI,
        { description: "Read-only Product Care summary dashboard" },
        async () => {
            const html = await fs.readFile(CARE_SUMMARY_HTML_PATH, "utf-8");
            return {
                contents: [{
                    uri: CARE_SUMMARY_UI_URI,
                    mimeType: RESOURCE_MIME_TYPE,
                    text: html
                }]
            };
        }
    );

    return server;
}

// ---------------------------------------------------------------------------
// Stateless Streamable HTTP endpoint
// ---------------------------------------------------------------------------
app.post("/mcp", async (req, res) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined
    });

    // Close only when the response is finished, so streamed replies are not cut off.
    res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
    });

    try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error("MCP request error:", error?.message ?? error);
        if (!res.headersSent) {
            res.status(500).json(rpcError(-32603, "Internal MCP server error"));
        }
    }
});

// Stateless mode has no standalone SSE stream and no sessions to terminate.
const methodNotAllowed = (_req, res) => {
    res.status(405).set("Allow", "POST").json(rpcError(-32000, "Method not allowed."));
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.get("/", (_req, res) => {
    res.send("Product Care Assistant MCP server is running.");
});

// Malformed JSON bodies get a clean 400 instead of an HTML stack trace.
app.use((err, _req, res, next) => {
    if (err?.type === "entity.parse.failed") {
        return res.status(400).json(rpcError(-32700, "Parse error"));
    }
    next(err);
});

app.listen(PORT, () => {
    console.log(`Product Care Assistant running at http://localhost:${PORT}/mcp`);
    if (!API_KEY) {
        console.warn("WARNING: MCP_API_KEY is not set. /mcp is unauthenticated (allowed only outside production).");
    }
});
