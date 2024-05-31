import fs from "fs";
import { Command } from "commander";
import puppeteer from "puppeteer";
import helpers from "./scrapers/helpers.js";

import scrapers from "./scrapers/index.js";

const program = new Command();
program
  .name("canvas-scraper")
  .description("Scrape data from a canvas course")
  .argument(
    "<url>",
    "Course Homepage URL (e.g. https://<school_domain>/courses/<course_id>)"
  )
  .option("-o, --output <dir_name>", "output directory name", "courses/course")
  .option("-c, --cookies <path>", "path to cookies file", "cookies.json")
  .option("-a", "scrape assignments", false)
  .option("-m", "scrape modules", false)
  .action(async (url, options) => {
    // url parsing
    const regex = /^https:\/\/([^/]+)\/courses\/([^/]+)(\/.*)?$/;

    const match = url.match(regex);
    if (!match) {
      console.log(
        "Invalid URL format. The URL should match the pattern https://<domain>/courses/<courseid>"
      );
      process.exit(1);
    }

    const domain = match[1];
    const courseid = match[2];
    url = `https://${domain}/courses/${courseid}`;

    console.log(`*** SCRAPING COURSE FROM ${url} ***`);
    console.log(`FLAGS: ${JSON.stringify(options)}`);

    // read cookies
    let cookies = options.cookies;
    try {
      cookies = JSON.parse(fs.readFileSync("cookies.json"));
    } catch (e) {
      console.log("ERROR: COULD NOT READ COOKIES");
      console.log(e);
      process.exit(1);
    }

    // create output directory
    const dir = options.output;
    if (fs.existsSync(dir))
      fs.rmSync(dir, { directory: true, recursive: true });
    fs.mkdirSync(dir, { recursive: true });

    // scrape course
    const browser = await puppeteer.launch({ headless: "new" });
    const page = await helpers.newPage(browser, cookies, url);
    await page.pdf({ path: `${dir}/.HOMEPAGE.pdf`, format: "Letter" });
    page.close();

    if (options.a) await scrapers.scrapeAssignments(browser, cookies, url, dir);
    if (options.m) await scrapers.scrapeModules(browser, cookies, url, dir);

    browser.close();
    console.log("*** SCRAPING COMPLETE ***");
  });

program.parse();
