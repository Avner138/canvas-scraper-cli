import fs from "fs";
import helpers from "../helpers.js";

async function scrapeModule(browser, cookies, dir, sectionName, module) {
  helpers.print("NOTE", `MODULE '${module.name}'`, `STARTING SCRAPING`, 1);
  fs.mkdirSync(`${dir}/MODULES/${sectionName}/${module.name}`);

  const page = await helpers.newPage(browser, cookies, module.url);
  await page.pdf({
    path: `${dir}/MODULES/${sectionName}/${module.name}/.MODULE.pdf`,
    format: "Letter",
  });

  let pDownloads = [];
  try {
    pDownloads = await helpers.searchAndDownload(
      page,
      cookies,
      `${dir}/MODULES/${sectionName}/${module.name}`,
      "span > a"
    );
  } catch (e) {
    helpers.print(
      "ERROR",
      `MODULE ${module.name}`,
      `COULD NOT SCRAPE ${module.name}`,
      1,
      e
    );
  }

  helpers.print("NOTE", `MODULE '${module.name}'`, `DONE SCRAPING`, 1);
  page.close();
  return pDownloads;
}

async function getModules(page) {
  return await helpers.getSections(page);
}

async function scrapeModules(browser, cookies, url, dir) {
  await helpers.scrapeSections(
    browser,
    cookies,
    url,
    dir,
    "module",
    getModules,
    scrapeModule
  );
}

export default scrapeModules;
