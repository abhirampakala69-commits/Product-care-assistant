
import "dotenv/config";

const url = process.env.SUPABASE_URL;

if (!url) {
  console.error("SUPABASE_URL is missing from .env");
  process.exit(1);
}

try {
  console.log("Testing Supabase HTTPS connection...");

  const response = await fetch(`${url}/rest/v1/`);

  console.log("HTTP status:", response.status);
  console.log("Connection reached Supabase.");
} catch (error) {
  console.error("Connection failed:", error.message);
  console.error("Cause:", error.cause?.code ?? "Not provided");
}
