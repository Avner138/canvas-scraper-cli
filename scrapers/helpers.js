import fs from "fs";
import fetch from "node-fetch";
import path from "path";
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
    await page.goto(url);
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
};

export default exported;
