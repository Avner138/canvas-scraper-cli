import fs from "fs";
import fetch from "node-fetch";
import path from "path";
import http from "http";
import { Browser, Page } from "puppeteer";
import { Readable } from "stream";

const exported = {
  /**
   * Creates a new page with the given cookies and navigates to the given URL
   * @param {Browser} browser puppeteer browser
   * @param {Object} cookies cookies to use
   * @param {string} url URL to navigate to
   * @returns {Promise<Page>} new page
   */
  async newPage(browser, cookies, url) {
    const page = await browser.newPage();
    await page.setCookie(...cookies);
    const response = await page.goto(url);
    page.status = response.status();
    return page;
  },

  /**
   * Sanitizes a string to be used as a filename
   * @param {string} string string to sanitize
   * @returns {string} string with invalid characters replaced with "-"
   */
  stripInvalid(string) {
    return string.replaceAll(/[/\\?%*:|"<>]/g, "-").trim();
  },

  /**
   * Downloads a file from the given URL using the given cookies
   * @param {string} url URL to download from
   * @param {object} cookies cookies to use
   * @param {string} dir directory to download to
   * @param {string} backupName name to use if no filename is found in the response headers
   * @returns {Promise<boolean>} whether or not the file was downloaded successfully
   */
  async downloadFile(url, cookies, dir, backupName) {
    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: {
        Cookie: cookies
          .map((cookie) => `${cookie.name}=${cookie.value}`)
          .join("; "),
      },
    });

    let filename = backupName;
    const contentDisposition = response.headers.get("content-disposition");
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="(.+?)"/);
      if (match) {
        filename = match[1];
        filename = this.stripInvalid(filename);
      }
    }

    const fileStream = fs.createWriteStream(path.join(dir, filename));
    await response.body.pipe(fileStream);
    return !(filename === backupName);
  },

  /**
   * Downloads files from an array of URLs using the given cookies
   * @param {Array<string>} urls URLs to download from
   * @param {object} cookies cookies to use
   * @param {string} dir directory to download to
   * @returns {Promise<Array<string>>} array of URLs that could not be downloaded
   */
  async downloadFiles(urls, cookies, dir) {
    let problematic = [];

    for (let i = 0; i < urls.length; i++) {
      let success = await this.downloadFile(
        urls[i],
        cookies,
        `${dir}`,
        `download_${i}.txt`
      );
      if (!success) problematic.push(urls[i]);
    }

    return problematic;
  },

  /**
   * Searches for links via a selector that include a certain string and downloads them
   * @param {Page} page page to search on
   * @param {Object} cookies cookies to use
   * @param {string} dir directory to download to
   * @param {string} selector query selector to search for links
   * @param {string} includes string that the link must include
   * @returns {Promise<Array<string>>} array of URLs that could not be downloaded
   */
  async searchAndDownload(
    page,
    cookies,
    dir,
    selector = "a",
    includes = "download?download"
  ) {
    let downloads = await page.evaluate(
      (selector, includes) => {
        return Array.from(document.querySelectorAll(selector))
          .map((a) => a.href)
          .filter((url) => url.includes(includes));
      },
      selector,
      includes
    );

    return await this.downloadFiles(downloads, cookies, dir);
  },

  /**
   * Prints a message to the console
   * @param {string} type type of message
   * @param {string} name name of item being printed
   * @param {string} message message to print
   * @param {Number} indent number of indents to use
   * @param {any} additional additional information to print (e.g error stack trace)
   */
  print(type, name, message, indent = 0, additional = null) {
    console.log(`[${type}]${"  ".repeat(indent)} ${name} | ${message}`);
    if (additional) console.log(additional);
  },

  /**
   * Writes data to a file
   * @param {string} dir directory to write to
   * @param {string} filename name of file to write to
   * @param {any} data data to write
   */
  async writeFile(dir, filename, data) {
    const textStream = Readable.from(data);
    const fileStream = fs.createWriteStream(path.join(dir, filename));
    await textStream.pipe(fileStream);
  },

  types: {
    assignment: {
      s: "assignment",
      p: "assignments",
    },
    module: {
      s: "module",
      p: "modules",
    },
    quiz: {
      s: "quiz",
      p: "quizzes",
    },
  },

  /**
   * Gets all sections from a page
   * @param {Page} page page to scrape from
   * @param {string} sectionSelector selector for sections
   * @param {string} headerSelector selector for section headers
   * @param {string} itemSelector selector for items in sections
   * @returns {Promise<Array<object>>} array of sections
   */
  async getSections(page, sectionSelector, headerSelector, itemSelector) {
    let sections = await page.evaluate(
      (sectionSelector, headerSelector, itemSelector) => {
        // get all sections
        return Array.from(document.querySelectorAll(sectionSelector)).map(
          (section) => {
            // get all links in the section
            let name = section.querySelector(headerSelector).innerText;
            let links = Array.from(section.querySelectorAll(itemSelector))
              .map((link) => {
                let url = link.href;
                let name = link.innerText;
                let grade;
                if (url.includes("/assignments/")) {
                  try {
                    grade =
                      link.parentNode.querySelector(".score-display").innerText;
                  } catch (e) {
                    grade = "NA";
                  }
                }

                return { name, url, grade };
              })
              .filter((a) => !a.url.includes("reviewee_id="));

            return { name, links };
          }
        );
      },
      sectionSelector,
      headerSelector,
      itemSelector
    );

    for (let section of sections) {
      section.name = this.stripInvalid(section.name);
      for (let link of section.links) {
        link.name = this.stripInvalid(link.name);
        if (link.grade) link.grade = this.stripInvalid(link.grade);
      }
    }

    return sections;
  },

  /**
   * Scrapes sections of a course
   * @param {Browser} browser puppeteer browser
   * @param {Object} cookies cookies to use
   * @param {string} url url to course homepage
   * @param {string} dir directory to save to
   * @param {string} type type of page (e.g module, assignment)
   * @param {Function} gettingFunction function to get sections
   * @param {Function} scrapingFunction function to scrape a specific item in a section
   */
  async scrapeSections(
    browser,
    cookies,
    url,
    dir,
    type,
    gettingFunction,
    scrapingFunction
  ) {
    console.log(`=== SCRAPING ${this.types[type].p.toUpperCase()} ===`);
    fs.mkdirSync(`${dir}/${this.types[type].p.toUpperCase()}`);
    const page = await this.newPage(
      browser,
      cookies,
      `${url}/${this.types[type].p}`
    );
    if (page.status !== 200) {
      this.print(
        "ERROR",
        this.types[type].p.toUpperCase(),
        `Could not load ${this.types[type].p} page. Skipping...`,
        0,
        http.STATUS_CODES[page.status]
      );
      return;
    }

    if (type === "assignment") {
      let submissionsURL = `${url.replace(
        "/courses",
        "/api/v1/courses"
      )}/students/submissions?per_page=50`;
      try {
        await page.waitForResponse(submissionsURL, { timeout: 5000 });
      } catch (e) {
        console.log(
          "[WARNING] COULD NOT GET SUBMISSIONS REQUEST, CONTINUING ANYWAY..."
        );
      }
    }

    await page.pdf({
      path: `${dir}/${this.types[type].p.toUpperCase()}/.${this.types[
        type
      ].p.toUpperCase()}.pdf`,
      format: "Letter",
    });

    const sections = await gettingFunction(page);

    let pSections = [];
    for (const section of sections) {
      try {
        let pLinks = [];
        this.print(
          "NOTE",
          `${this.types[type].s.toUpperCase()} SECTION '${section.name}'`,
          `STARTING SCRAPING`,
          0
        );
        fs.mkdirSync(
          `${dir}/${this.types[type].p.toUpperCase()}/${section.name}`
        );
        for (const link of section.links) {
          try {
            let pDownloads = await scrapingFunction(
              browser,
              cookies,
              dir,
              section.name,
              link
            );
            if (pDownloads.length > 0)
              pLinks.push({ name: link.name, links: pDownloads });
          } catch (e) {
            this.print(
              "ERROR",
              `${this.types[type].s.toUpperCase()} '${link.name}'`,
              `COULD NOT SCRAPE`,
              1,
              e
            );
          }
        }
        if (pLinks.length > 0)
          pSections.push({ name: section.name, links: pLinks });
      } catch (e) {
        this.print(
          "ERROR",
          `${this.types[type].s.toUpperCase()} SECTION '${section.name}'`,
          `COULD NOT SCRAPE`,
          0,
          e
        );
      }
    }

    try {
      this.printSummary(sections, pSections, type);
    } catch (e) {
      this.print(
        "ERROR",
        `${this.types[type].p.toUpperCase()} SUMMARY`,
        `COULD NOT PRINT`,
        0,
        e
      );
    }

    page.close();
  },

  /**
   * prints a summary of scraping results by section
   * @param {Array<Object>} sections
   * @param {Array<Object>} pSections
   * @param {string} type
   */
  printSummary(sections, pSections, type) {
    console.log(`--- ${this.types[type].p.toUpperCase()} SCRAPING SUMMARY ---`);
    console.log(
      `[NOTE] TOTAL ${this.types[type].s.toUpperCase()} SECTIONS: ${
        sections.length
      }`
    );
    let itemCount = sections
      .map((section) => {
        return section.links.length;
      })
      .reduce((a, b) => a + b, 0);
    console.log(
      `[NOTE] TOTAL ${this.types[type].p.toUpperCase()}: ${itemCount}`
    );

    if (pSections.length > 0) {
      console.log("[WARNING] Some files failed to download...");
      for (let section of pSections) {
        console.log(`  ${section.name}`);
        for (let link of section.links) {
          console.log(`    ${link.name}`);
          for (let file of link.links) {
            console.log(`      ${file}`);
          }
        }
      }
    }
  },
};

export default exported;
