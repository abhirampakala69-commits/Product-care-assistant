
import "dotenv/config";
import { supabase } from "./supabase.js";

async function testConnection() {
    const { data, error } = await supabase
        .from("products")
        .select("id")
        .limit(1);

    if (error) {
        console.error("Supabase query failed:", error.message);
        process.exitCode = 1;
        return;
    }

    console.log("Supabase connection successful!");
    console.log("Products table is accessible.");
    console.log("Rows returned:", data.length);
}

testConnection();
