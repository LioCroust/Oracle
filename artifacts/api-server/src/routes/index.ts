import { Router, type IRouter } from "express";
import healthRouter from "./health";
import tarotRouter from "./tarot";
import creditsRouter from "./credits";
import statsRouter from "./stats";

const router: IRouter = Router();

router.use(healthRouter);
router.use(tarotRouter);
router.use(creditsRouter);
router.use(statsRouter);

export default router;
