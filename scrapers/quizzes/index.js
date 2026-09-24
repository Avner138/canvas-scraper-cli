import helpers from "../helpers.js";

async function scrapeQuiz(browser, cookies, dir, sectionName, quiz) {
  helpers.print("NOTE", `QUIZ '${quiz.name}'`, `STARTING SCRAPING`, 1);
  // See the note in scrapers/modules/index.js — a stable identity so a
  // renamed quiz is re-found rather than duplicated.
  const quizDir = helpers.mkUniqueDir(
    `${dir}/QUIZZES/${sectionName}/${quiz.name}`,
    quiz.url
  );

  const page = await helpers.newPage(browser, cookies, quiz.url);

  let pDownloads = [];
  // Closed in the finally — see the note in scrapers/modules/index.js.
  try {
    await helpers.capturePdf(
      page,
      { path: `${quizDir}/QUIZ.pdf`, format: "Letter" },
      "quiz"
    );

    pDownloads = await helpers.searchAndDownload(
      page,
      cookies,
      quizDir,
      "a",
      "?download"
    );

    const externalSelector = JSON.parse(process.env.config).externalSelectors
      ?.quiz;
    pDownloads = pDownloads.concat(
      await helpers.searchAndDownloadExternal(page, cookies, quizDir, externalSelector)
    );
  } catch (e) {
    helpers.print(
      "ERROR",
      `QUIZ ${quiz.name}`,
      `COULD NOT SCRAPE ${quiz.name}`,
      1,
      e
    );
  } finally {
    await page.close().catch(() => {});
  }

  helpers.print("NOTE", `QUIZ '${quiz.name}'`, `DONE SCRAPING`, 1);
  return pDownloads;
}

async function getQuizzes(page) {
  const selectors = JSON.parse(process.env.config).selectors.quiz;
  return await helpers.getSections(
    page,
    selectors.sectionSelector,
    selectors.headerSelector,
    selectors.itemSelector
  );
}

async function scrapeQuizzes(browser, cookies, url, dir) {
  await helpers.scrapeSections(
    browser,
    cookies,
    url,
    dir,
    "quiz",
    getQuizzes,
    scrapeQuiz
  );
}

export default scrapeQuizzes;
