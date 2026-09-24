import helpers from "../helpers.js";

async function scrapeModule(browser, cookies, dir, sectionName, module) {
  helpers.print("NOTE", `MODULE '${module.name}'`, `STARTING SCRAPING`, 1);
  // The item URL is a stable identity: it survives the display name changing,
  // so a re-run renames the folder rather than spawning a second one. Only
  // assignments passed one before, which left modules and quizzes out of the
  // manifest's item registry entirely.
  const moduleDir = helpers.mkUniqueDir(
    `${dir}/MODULES/${sectionName}/${module.name}`,
    module.url
  );

  const page = await helpers.newPage(browser, cookies, module.url);

  let pDownloads = [];
  // The page is closed in the finally: a throw anywhere below would otherwise
  // strand a live CDP target, and enough stranded targets eventually wedge the
  // browser connection (Network.enable and friends time out).
  try {
    await helpers.capturePdf(
      page,
      { path: `${moduleDir}/MODULE.pdf`, format: "Letter" },
      "module"
    );

    pDownloads = await helpers.searchAndDownload(
      page,
      cookies,
      moduleDir,
      "span > a"
    );

    const externalSelector = JSON.parse(process.env.config).externalSelectors
      ?.module;
    pDownloads = pDownloads.concat(
      await helpers.searchAndDownloadExternal(page, cookies, moduleDir, externalSelector)
    );
  } catch (e) {
    helpers.print(
      "ERROR",
      `MODULE ${module.name}`,
      `COULD NOT SCRAPE ${module.name}`,
      1,
      e
    );
  } finally {
    await page.close().catch(() => {});
  }

  helpers.print("NOTE", `MODULE '${module.name}'`, `DONE SCRAPING`, 1);
  return pDownloads;
}

async function getModules(page) {
  const selectors = JSON.parse(process.env.config).selectors.module;
  return await helpers.getSections(
    page,
    selectors.sectionSelector,
    selectors.headerSelector,
    selectors.itemSelector
  );
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
