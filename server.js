const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// Initialize Express app
const app = express();
const PORT = 3000;




// --- Maintenance Mode Setup ---
// Set this flag to true to enable maintenance mode.
let maintenanceMode = false;

// Middleware to enforce maintenance mode
app.use((req, res, next) => {
  if (maintenanceMode) {
    return res
      .status(503)
      .send("Server is under maintenance. Please try again later.");
  }
  next();
});
// --- End Maintenance Mode Setup ---





// JSON file paths
const DATA_FILE = "results.json";
const CAMPSITES_FILE = "campsites.json";
const DATES_FILE = "dates.json";
const SUPPLIER_CACHE_FILE = "supplierCache.json";

// Configuration
const LIMIT_TEST_REQUESTS = false;
const REFRESH_INTERVAL = 48 * 60 * 60 * 1000; // 48 hours

// Helper function: Load JSON files safely
const loadFile = (filePath, defaultValue = {}) => {
  try {
    return fs.existsSync(filePath)
      ? JSON.parse(fs.readFileSync(filePath, "utf-8") || "{}")
      : defaultValue;
  } catch (error) {
    console.error(`Error loading ${filePath}:`, error);
    return defaultValue;
  }
};

// Helper function: Save JSON file safely
const saveFile = (filePath, data) => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error(`Error saving ${filePath}:`, error);
  }
};

// Helper function: Delay execution
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Initialize Supplier Cache
const initializeSupplierCache = () => {
  if (!fs.existsSync(SUPPLIER_CACHE_FILE)) saveFile(SUPPLIER_CACHE_FILE, {});
};

// Fetch supplier data with caching
const fetchSupplierData = async (itemId) => {
  const supplierCache = loadFile(SUPPLIER_CACHE_FILE);

  // Check if supplier data is already cached
  if (supplierCache[itemId]) {
    console.log(`Cache hit for item ID: ${itemId}`);
    return supplierCache[itemId];
  }

  console.log(`Cache miss for item ID: ${itemId}. Fetching from API...`);

  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      // 🔹 Introduce a 0-1 second delay before each API request
      const randomDelay = Math.random() * 200;
      await delay(randomDelay);

      // Fetch supplier data from API
      const response = await axios.get(
        `https://www.allcamps.de/api/twenty/v2/allcamps/de/accommodation/card/${itemId}`
      );
      const supplier = response.data?.supplier || null;

      // Save the supplier data in cache
      supplierCache[itemId] = supplier;
      saveFile(SUPPLIER_CACHE_FILE, supplierCache);

      return supplier; // Return fetched supplier data
    } catch (error) {
      attempt++;
      console.error(`Attempt ${attempt} failed for item ID: ${itemId}`, error);

      if (attempt >= maxRetries) {
        console.error(`Failed to fetch supplier data after ${maxRetries} attempts.`);
        return null;
      }

      // 🔹 Wait an additional 1 second before retrying
      await delay(1000);
    }
  }
};

// Create request body for API
const createRequestBody = (date, campsite, persons = { adults: 2, children: [] }) => ({
  filters: { site: { facilities: [] }, accommodation: { categories: ["mobile-home"], bedrooms: [] } },
  parameters: {
    map: false,
    includeTopFacilities: true,
    funnel: "camping",
    date,
    duration: 7,
    country: campsite.country,
    area: campsite.region,
    persons,
    site: campsite.name,
  },
  meta: { limit: 10, order: "desc", orderBy: "popular", orderSettingsLabel: "popular-desc", page: 1 },
});

const fetchData = async (body, campsite, date) => {
  const WEBSITE_NAME = "ALLCAMPS"; // 🔹 Define the website source

  try {
    const response = await axios.post(
      "https://www.allcamps.de/api/twenty/v2/allcamps/de/search/accommodations",
      body
    );
    const rawData = response.data;

    // Combine accommodations and alternatives
    const combined = [...(rawData.data.accommodations || []), ...(rawData.data.alternatives || [])];

    const transformedData = {};
    const timestamp = new Date().toISOString().replace("T", ", ").slice(0, 16);

    for (const item of combined) {
      const supplier = await fetchSupplierData(item.id);

      const key = `${campsite.code}_from_${WEBSITE_NAME}_at_${date}_#${item.id}`;

      transformedData[key] = {
        id: item.id,
        name: item.name,
        category: item.category,
        categorySlug: item.categorySlug,
        maxPersons: item.maxPersons,
        bedrooms: item.bedrooms,
        aircondition: item.aircondition,
        dogAllowed: item.dogAllowed,
        priceBeforeFeesBeforeDiscount: item.priceBeforeFeesBeforeDiscount,
        priceBeforeFeesAfterDiscount: item.priceBeforeFeesAfterDiscount,
        size: item.size,
        arrivalDate: item.arrivalDate,
        duration: item.duration,
        supplier,
        campsite: campsite.code, // 🔹 Store campsite code separately for filtering
        requestedDate: date,
        website: WEBSITE_NAME, // 🔹 Store website name for clarity
        timestamp,
      };

      // Introduce a 0-1 second delay before processing the next item
      await delay(Math.random() * 100);
    }

    return transformedData;
  } catch (error) {
    console.error("Error fetching data:", error);
    return null;
  }
};

const scrapeCampsite = async (campsiteToFetch) => {
  const dates = loadFile(DATES_FILE);
  const campsites = loadFile(CAMPSITES_FILE); // Load campsites.json once
  const currentResults = loadFile(DATA_FILE);
  const newResults = {};

  for (const [dateName, date] of Object.entries(dates)) {
    console.log(`🔄 Fetching data for ${campsiteToFetch.code} on ${dateName} (${date})`);

    const requestBody = createRequestBody(date, campsiteToFetch);
    const data = await fetchData(requestBody, campsiteToFetch, date);

    if (data) {
      Object.assign(newResults, data);
    } else {
      console.error(`❌ Failed to fetch data for ${campsiteToFetch.name} on ${date}. Skipping update.`);
    }

    await delay(1000 + Math.random() * 1000);
  }

  // 🔹 Remove old entries for this campsite based on campsite CODE
  const updatedResults = Object.fromEntries(
    Object.entries(currentResults).filter(
      ([, value]) => value.campsite !== campsiteToFetch.code
    )
  );

  // Merge new results into updatedResults
  Object.assign(updatedResults, newResults);

  // Save the updated results
  saveFile(DATA_FILE, updatedResults);

  // 🔍 Debug: Log whether new data was fetched
  console.log(`📊 New data count for ${campsiteToFetch.name}: ${Object.keys(newResults).length}`);

  // ✅ Only update lastUpdate if newResults has data
  if (Object.keys(newResults).length > 0) {
    const timestamp = new Date().toISOString();
    campsiteToFetch.lastUpdate = timestamp;
    
    // 🔍 Debug: Log the timestamp before saving
    console.log(`✅ Setting lastUpdate for ${campsiteToFetch.code} to: ${timestamp}`);

    // Find and update the correct campsite in campsites.json
    const campsiteIndex = campsites.findIndex(c => c.code === campsiteToFetch.code);
    if (campsiteIndex !== -1) {
      campsites[campsiteIndex].lastUpdate = timestamp; // ✅ Update campsite entry
      saveFile(CAMPSITES_FILE, campsites); // ✅ Save updated campsites.json
      console.log(`✅ Successfully updated lastUpdate for ${campsiteToFetch.code}`);
    } else {
      console.error(`❌ Could not update lastUpdate timestamp: Campsite ${campsiteToFetch.code} not found in campsites.json`);
    }
  } else {
    console.warn(`⚠️ Skipping lastUpdate update: No new results for ${campsiteToFetch.code}`);
  }
};

// API Endpoints
app.get("/scrape", (req, res) => {
  res.status(200).send("Scraping started");

  setImmediate(async () => {
    const campsites = loadFile(CAMPSITES_FILE);
    const refreshTime = new Date(Date.now() - REFRESH_INTERVAL);
    const campsiteToFetch = campsites.find((c) => !c.lastUpdate || new Date(c.lastUpdate) < refreshTime);

    if (campsiteToFetch) await scrapeCampsite(campsiteToFetch);
    else console.log("No campsites need updating.");
  });
});

app.get("/deleteAndScrapeAll", (req, res) => {
  res.status(200).send("Deleting and scraping all data started");

  setImmediate(async () => {
    saveFile(DATA_FILE, {}); // Clear results
    for (const campsite of loadFile(CAMPSITES_FILE)) await scrapeCampsite(campsite);
    console.log("Scraping process completed.");
  });
});

app.get("/forceScrape", (req, res) => {
  const campsiteCode = req.query.campsite;
  const campsiteToScrape = loadFile(CAMPSITES_FILE).find((c) => c.code === campsiteCode);

  if (!campsiteCode) return res.status(400).json({ success: false, message: "Missing campsite code." });
  if (!campsiteToScrape) return res.status(404).json({ success: false, message: `Campsite '${campsiteCode}' not found.` });

  res.status(200).send(`Force scraping started for campsite '${campsiteCode}'`);

  setImmediate(() => scrapeCampsite(campsiteToScrape));
});

app.get("/data", (req, res) => {
  res.json(loadFile(DATA_FILE, { error: "No data found. Please run a scrape first." }));
});

app.get("/getCampsites", (req, res) => {
  res.json(loadFile(CAMPSITES_FILE, { error: "No campsites found. Please check setup configuration." }));
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  initializeSupplierCache();
});
