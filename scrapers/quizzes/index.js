import fs from "fs";
import helpers from "../helpers.js";

async function scrapeQuiz(browser, cookies, dir, sectionName, quiz) {
  helpers.print("NOTE", `QUIZ '${quiz.name}'`, `STARTING SCRAPING`, 1);
  fs.mkdirSync(`${dir}/QUIZZES/${sectionName}/${quiz.name}`);

  const page = await helpers.newPage(browser, cookies, quiz.url);
  await page.pdf({
    path: `${dir}/QUIZZES/${sectionName}/${quiz.name}/.QUIZ.pdf`,
    format: "Letter",
  });

  let pDownloads = [];
  try {
    pDownloads = await helpers.searchAndDownload(
      page,
      cookies,
      `${dir}/QUIZZES/${sectionName}/${quiz.name}`,
      "a",
      "?download"
    );
  } catch (e) {
    helpers.print(
      "ERROR",
      `QUIZ ${quiz.name}`,
      `COULD NOT SCRAPE ${quiz.name}`,
      1,
      e
    );
  }

  helpers.print("NOTE", `QUIZ '${quiz.name}'`, `DONE SCRAPING`, 1);
  page.close();
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
