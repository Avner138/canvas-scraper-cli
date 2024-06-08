import scrapeAssignments from "./assignments/index.js";
import scrapeModules from "./modules/index.js";
import scrapeQuizzes from "./quizzes/index.js";

const scrapers = {
  scrapeAssignments,
  scrapeModules,
  scrapeQuizzes,
};

export default scrapers;
