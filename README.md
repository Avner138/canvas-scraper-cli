# Canvas Scraper CLI

A NodeJS command-line interface for scraping and downloading data (e.g. assignments and modules) from a Canvas course.

## Dependencies

Canvas-Scraper uses [Puppeteer](https://pptr.dev/), a headless browser, to navigate and scrape data from Canvas. This requires some form of [Chromium](https://www.chromium.org/chromium-projects/) to be available on the system. The easiest way to do this is by installing [Google Chrome](https://www.google.com/chrome/).

## Getting Started

You'll first need to get the cookies for your current Canvas session to allow the scraper to have credentials to your Canvas. This needs to be done in JSON format (an example can be found in cookies-example.json).

The easiest way to do this is by logging into Canvas in your browser and using an extension to export your current cookies (e.g. [CookieManager](https://chromewebstore.google.com/detail/cookiemanager-cookie-edit/hdhngoamekjhmnpenphenpaiindoinpo) for Chrome).

### Using Pre-Compiled Release

First, download the latest version from the [Releases](https://github.com/xxmistacruzxx/canvas-scraper/releases) page and extract the ZIP file.

Inside the extracted folder, navigate to the "dist" folder and copy the executable for your respective operating system into the main directory of the extracted folder.

To use the executable, simply navigate to the directory in a shell and call the executable.

e.g Windows<br/>
`./canvas-scraper.exe`

### Using Source Code

You will need [NodeJS](https://nodejs.org/en) and [NPM](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm).

Once installed, download the project dependencies using...

`npm i`

After, you can simply run the entry file directly...

`node index.js ...`

or via the NPM script...

`npm run start ...`

## Usage

```
Usage: canvas-scraper [options] <url>

Scrape data from a canvas course

Arguments:
  url                      Course Homepage URL (e.g. https://<school_domain>/courses/<course_id>)

Options:
  -o, --output <dir_name>  output directory name (default: "courses/course")
  -c, --cookies <path>     path to cookies file (default: "cookies.json")
  -a                       scrape assignments (default: false)
  -m                       scrape modules (default: false)
  -h, --help               display help for command
```

You must use the 'a' and/or 'm' flags, otherwise no data will be scraped.

## Video Tutorial

Coming soon...
