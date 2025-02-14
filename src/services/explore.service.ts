import { ConflictException, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import * as cheerio from 'cheerio';
import puppeteer, { Browser, Page } from 'puppeteer';

import { ELogColor, UtilsService } from './utils.service';
import { JsonService } from './json.service';

import { AlcoholService } from '../alcohol/alcohol.service';

type Link = {
  asin?: string;
  url: string;
  explored: number;
  thumbSrc?: string;
};

@Injectable()
export class ExploreService implements OnModuleInit {
  private links: Link[];
  private page: Page;
  private browser: Browser;
  private cheerioAPI: cheerio.CheerioAPI;
  private websiteExploreHost: string;

  private notTranslatedKeys: string[] = [];

  private targetKeyword = 'whisky';
  private langCountryCode = 'fr_FR';

  private _stopExploration = false;

  public stopExploration(state: boolean): void {
    this._stopExploration = state;
    if (state) {
      this.utilsService.coloredLog(ELogColor.FgRed, `STOP EXPLORATION!`);
    } else {
      this.utilsService.coloredLog(ELogColor.FgYellow, `START EXPLORATION!`);
    }
  }

  constructor(
    private readonly configService: ConfigService,
    private readonly utilsService: UtilsService,
    private readonly jsonService: JsonService,
    private readonly alcoholService: AlcoholService,
  ) {
    this.websiteExploreHost = this.configService.get<string>(
      'WEBSITE_EXPLORE_HOST',
    );
  }

  onModuleInit() {
    this.start();
  }

  public async start() {
    console.log('ExploreService::start');
    if (!this.websiteExploreHost) {
      console.log('No WEBSITE_EXPLORE_HOST defined!');
      return;
    }

    // Save links data in a json file
    const jsonFileName = `jsons/${this.targetKeyword}-exploration.json`;
    const explorationData = await this.jsonService.readJsonFile(jsonFileName);

    if (!explorationData) {
      await this.jsonService.writeJsonFile(jsonFileName, {
        data: { test: 'value' },
      });
    }
    // TODO: Save links data in jsons

    this.links = [
      {
        asin: 'B07BPLMSMC',
        url: '/dp/B07BPLMSMC',
        explored: null,
      },
      // {
      //   url: `/s?k=${this.targetKeyword}`,
      //   explored: null,
      // },
    ];
    await this.initPuppeteer();

    let nextLink: Link;
    let productData: any;
    let exploredLinks: number;
    let explorationPercent: string;
    while (
      this.links.find((link) => link.explored === null) &&
      !this._stopExploration
    ) {
      nextLink = this.links.find((link) => link.explored === null);

      productData = await this.scraperWebsite(
        `${this.websiteExploreHost}${nextLink.url}`,
      );
      if (productData) {
        try {
          await this.alcoholService.create(productData);
        } catch (error) {
          if (error instanceof ConflictException) {
            this.utilsService.coloredLog(
              ELogColor.FgYellow,
              `Échec de la création du alcohol : ${error.message}`,
            );
          } else {
            this.stopExploration(true);
          }
        }
      }

      if (this._stopExploration) {
        this.utilsService.coloredLog(ELogColor.FgRed, `> break while`);
        break;
      }

      nextLink.explored = Date.now();
      console.log('nextLink:', nextLink);
      exploredLinks = this.links.filter(
        (link) => link.explored === null,
      )?.length;
      explorationPercent = this.utilsService.roundPercent(
        exploredLinks,
        this.links.length,
      );
      console.log(
        'links restants',
        exploredLinks,
        '/',
        this.links.length,
        '-',
        explorationPercent,
      );
      console.log('notTranslatedKeys', this.notTranslatedKeys);

      this.utilsService.coloredLog(ELogColor.FgCyan, `Wait 10s...`);
      await this.utilsService.waitSeconds(10000);

      break;
    }

    await this.browser.close();
  }

  async initPuppeteer() {
    this.browser = await puppeteer.launch();

    // Définir les cookies d'authentification
    const cookieJsonFileName = `jsons/cookie.json`;
    const cookieData = await this.jsonService.readJsonFile(cookieJsonFileName);

    if (cookieData && Object.keys(cookieData).length > 0) {
      cookieData.map((cookie) => {
        if (!cookie.expires) {
          if (cookie.expirationDate) {
            cookie.expires = Number(cookie.expirationDate);
          } else {
            cookie.expires = -1;
          }
          delete cookie.expirationDate;
        }
        delete cookie.hostOnly;
        delete cookie.sameSite;
        delete cookie.storeId;
        delete cookie.id;
        if (!cookie.size) cookie.size = -1;
        return cookie;
      });

      await this.browser.setCookie(...cookieData);
    }

    this.page = await this.browser.newPage();
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
    );
  }

  async scraperWebsite(url: string) {
    await this.page.goto(url);
    // ... extraction des données avec Puppeteer ...

    // Récupérer le contenu HTML après le rendu de la page
    const html = await this.page.content();

    // Charger le HTML dans Cheerio
    const $ = cheerio.load(html);
    this.cheerioAPI = $;

    const canonicalLink = $('link[rel="canonical"]').attr('href');
    this.utilsService.coloredLog(
      ELogColor.FgCyan,
      `link canonical: ${canonicalLink}`,
    );

    if ($('.octopus-page-style').length > 0) {
      $('.octopus-page-style .octopus-pc-item').each(
        this.extractLink.bind(this),
      );
    }

    if ($('#search').length > 0) {
      $('#search [role="listitem"]').each(this.extractLink.bind(this));
    }

    if ($('#dp').length > 0) {
      $('#dp .a-carousel-card').each(this.extractLink.bind(this));

      $('#dp .apm-tablemodule-table th').each(
        this.extractLinkFromTable.bind(this),
      );

      let shortlink: string;
      console.log('#nav-link-accountList', $(`#nav-link-accountList`).text());
      if ($(`#nav-link-accountList`).text().includes('Identifiez-vous')) {
        this.utilsService.coloredLog(ELogColor.FgRed, 'Not logged!');
        this.stopExploration(true);
        return;
      } else {
        const buttonId = 'amzn-ss-get-link-button';
        const dropdownId = 'amzn-ss-tracking-id-dropdown-text';
        const selectTargetKey = `alcoholwhiskies-21`;
        const getLinkButtonId = 'amzn-ss-get-link-btn-text-announce';
        const shortlinkTextarea = 'amzn-ss-text-shortlink-textarea';

        await this.page.click(`#${buttonId}`);
        await this.utilsService.waitSeconds(2000);
        await this.page.select(`#${dropdownId}`, selectTargetKey);
        await this.utilsService.waitSeconds(2000);

        const trackingSelectValue = $(`#${dropdownId}`).val();
        console.log('trackingSelectValue:', trackingSelectValue);

        if (trackingSelectValue !== selectTargetKey) {
          this.utilsService.coloredLog(
            ELogColor.FgRed,
            `Problem => trackingSelectValue is ${trackingSelectValue}`,
          );
          this.stopExploration(true);
          return;
        }

        await this.page.click(`#${getLinkButtonId}`);
        await this.utilsService.waitSeconds(2000);

        shortlink = await this.page.evaluate((sel) => {
          const textarea = document.querySelector(sel) as HTMLTextAreaElement;
          return textarea ? textarea.value : null;
        }, `#${shortlinkTextarea}`);
        console.log('shortlink:', shortlink, '\n');
      }

      const dpClass = $('#dp').attr('class');
      console.log('#dp class', dpClass);
      if (dpClass?.length > 0 && !dpClass.includes('alcoholic_beverage')) {
        console.log('alcoholic_beverage IS NOT IN THE dpClass > RETURN!!!');
        return;
      }
      if (dpClass?.length > 0 && !dpClass.includes(this.langCountryCode)) {
        console.log(
          `${this.langCountryCode} IS NOT IN THE dpClass > RETURN!!!`,
        );
        return;
      }

      if ($('#ppd').length > 0) {
        const breadcrumbs = $('#wayfinding-breadcrumbs_container')
          .text()
          ?.replace(/\s+|\n/g, ' ')
          .toLowerCase();
        console.log('wayfinding-breadcrumbs:', breadcrumbs);

        if (
          breadcrumbs?.length > 0 &&
          !breadcrumbs.includes(`${this.targetKeyword}s`)
        ) {
          console.log(
            `${this.targetKeyword}s IS NOT IN THE breadcrumbs > RETURN!!!`,
          );
          return;
        }

        const metas = {
          title: $('meta[name="title"]').attr('content'),
          description: $('meta[name="description"]').attr('content'),
        };
        let title = $('title').text()?.trim();

        metas.title = this.utilsService.getAllButLast(metas.title, ' : ');

        metas.description = this.utilsService.getAllButLast(
          metas.description,
          ' : ',
        );

        title = this.utilsService.getAllButLast(title, ' : ');

        console.log('meta title:', metas.title);
        console.log('meta description:', metas.description);
        console.log('title:', title);

        const productTitle = $('#ppd #productTitle').text()?.trim();
        console.log('productTitle:', productTitle);

        /* ********************************************************************************* */

        const avgCustomerReviews = $(
          '#ppd #averageCustomerReviews #acrPopover a i >span',
        )
          .text()
          ?.trim();

        const customerReviewText = $(
          '#ppd #averageCustomerReviews #acrCustomerReviewText',
        )
          .text()
          ?.trim();

        const averageCustomerReviews = `${avgCustomerReviews} (${customerReviewText})`;
        console.log('averageCustomerReviews:', averageCustomerReviews);

        /* ********************************************************************************* */

        const price = $(
          '#ppd #apex_desktop #subscriptionPrice #sns-base-price .a-price.priceToPay',
        )
          .text()
          ?.trim();
        console.log('Price:', price);

        // console.log(
        //   'vatMessage',
        //   $('#ppd #apex_desktop_snsAccordionRowMiddle #vatMessage_feature_div')
        //     .text()
        //     ?.trim(),
        // );

        const landingImage = $('#ppd img#landingImage').attr('src');
        console.log('landingImage src:', landingImage);

        const dynamicImage = JSON.parse(
          $('#ppd img#landingImage').attr('data-a-dynamic-image') || '{}',
        );
        console.log('landingImage dynamicImage:', dynamicImage);

        const thumbnailImage = $('#ppd .imageThumbnail img').attr('src');
        console.log('thumbnailImage src:', thumbnailImage);

        /* ******************************* */

        const tableData = {};
        $('#ppd table.a-normal.a-spacing-micro tbody tr').each((i, row) => {
          const key = $(row).find('td.a-span3 span.a-text-bold').text().trim();
          const value = $(row)
            .find('td.a-span9 span.a-size-base.po-break-word')
            .text()
            .trim();
          if (key) {
            // Vérifier si la clé existe (pour éviter les lignes vides)
            tableData[key] = value;
          }
        });

        const translations = {
          Marque: 'brand',
          "Type d'alcool": 'alcoholType',
          Saveur: 'flavor',
          "Nombre d'unités": 'unitCount',
          "Nombre d'articles": 'numberOfItems',
          "Nombre d'article(s) dans l'emballage": 'numberOfItems',
          'Teneur en alcool': 'alcoholContent',
          'Type de régime': 'dietType',
          'Description du contenu du liquide': 'liquidContentsDescription',
          "Forme de l'article": 'itemForm',
          Format: 'itemForm',
          'Volume liquide': 'liquidVolume',
          "Nombre total d'unités": 'totalUnitCount',
          'Code article international': 'internationalArticleCode',
          "Poids de l'article": 'itemWeight',
          'Poids du produit': 'itemWeight',
          Âge: 'age',
          "Pays d'origine": 'countryOfOrigin',
          Certification: 'certification',
          'Volume indicatif': 'approximateVolume',
          Fabricant: 'manufacturer',
          'Région de production': 'productionRegion',
          "Numéro du modèle de l'article": 'itemModelNumber',
          Unités: 'units',
          'Dimensions du produit (L x l x h)': 'productDimensions',
          'Informations relatives aux allergènes': 'allergenInformation',
          Allergènes: 'allergenInformation',
          Description: 'description',
          "Information sur l'emballage": 'packagingInformation',
          'Suggestion de préparation': 'preparationSuggestion',
          Spécialité: 'speciality',
          'Conditions de conservation': 'storageConditions',
          Millésime: 'vintage',
        };

        const infos = {};

        for (const key in tableData) {
          if (translations.hasOwnProperty(key)) {
            infos[translations[key]] = tableData[key];
          } else {
            // Gérer les clés non traduites (facultatif)
            infos[key] = tableData[key]; // Conserver la clé originale
            console.warn(`Clé non traduite : ${key}`);
            if (!this.notTranslatedKeys.find((val) => val === key)) {
              this.notTranslatedKeys.push(key);
            } else {
              console.log(' > clé déjà présente');
            }
          }
        }

        /* ******************************* */
        const featureBullets: string[] = [];
        $('#ppd #feature-bullets li .a-list-item').each((i, element) => {
          // console.log('feature-bullets', $(element).text());
          featureBullets.push($(element).text()?.trim());
        });
        console.log('feature-bullets:', featureBullets);

        /* ******************************* */

        const tableTechData = {};
        $('#dp #productDetails_techSpec_section_1 tbody tr').each((i, row) => {
          const key = $(row).find('th').text().trim();
          const value = $(row).find('td').text().trim();
          if (key) {
            tableTechData[key] = value;
          }
        });

        const infosTech = {};

        for (const key in tableTechData) {
          if (translations.hasOwnProperty(key)) {
            infosTech[translations[key]] = tableTechData[key];
          } else {
            infosTech[key] = tableTechData[key]; // Conserver la clé originale
            console.warn(`Clé non traduite : ${key}`);
            if (!this.notTranslatedKeys.find((val) => val === key)) {
              this.notTranslatedKeys.push(key);
            } else {
              console.log(' > clé déjà présente');
            }
          }
        }

        const mergedInfos = { ...infos, ...infosTech };
        console.log('mergedInfos:', mergedInfos);

        /* ******************************* */

        const productDescription = $('#dp #productDescription').html()?.trim();
        console.log('productDescription:', productDescription);

        /* ******************************* */

        const imagesDescription: string[] = [];
        $(
          '#dp #aplus .desktop .aplus-module-wrapper.aplus-3p-fixed-width img',
        ).each((i, element) => {
          imagesDescription.push($(element).attr('data-src'));
        });
        console.log('imagesDescription:', imagesDescription);

        return {
          asin: this.extractASIN(canonicalLink),
          // canonicalLink,
          timestamp: {
            created: Date.now(),
          },
          // metas,
          // title,
          name: productTitle,
          breadcrumbs,
          averageCustomerReviews,
          price,
          image: {
            landing: dynamicImage, // landingImage ?
            thumbnail: thumbnailImage,
          },
          infos: mergedInfos,
          featureBullets,
          description: {
            product: productDescription,
            images: imagesDescription,
          },
          shortlink,
          type: this.targetKeyword,
          langCountryCode: this.langCountryCode,
        };
      }
    }
  }

  public extractASIN(url: string): string | null {
    try {
      let decodedUrl: string;
      try {
        decodedUrl = decodeURIComponent(url);
      } catch (decodeError) {
        console.error('Erreur de décodage URI :', decodeError);
        return null;
      }

      const match = decodedUrl.match(
        /\/([a-z]{2,}\/){0,2}(dp|gp\/product)\/([A-Z0-9]{10,})/i,
      );
      return match ? match[3] : null; // Retourner seulement l'ASIN (match[3])
    } catch (error) {
      console.error("Erreur lors de l'extraction de l'ASIN :", error);
      return null;
    }
  }

  private manageLinkAdding(href: string, thumbSrc?: string) {
    if (!thumbSrc) thumbSrc = '';
    if (href?.length > 0) {
      if (this.links.find((obj) => obj.url === href)) {
        console.log(href, 'already in links');
      } else {
        const productId = this.extractASIN(href);
        console.log('asin:', productId);
        if (!productId && href.startsWith('/vdp/')) {
          this.utilsService.coloredLog(
            ELogColor.FgRed,
            'vdp => Lien non ajouté!\n',
          );
          return;
        }
        if (productId && this.links.find((obj) => obj.asin === productId)) {
          this.utilsService.coloredLog(
            ELogColor.FgRed,
            'ASIN already in links => Lien non ajouté!\n',
          );
          return;
        }
        this.utilsService.coloredLog(ELogColor.FgGreen, 'Lien ajouté!\n');
        this.links.push({
          asin: productId,
          url: href,
          explored: null,
          // thumbSrc,
        });
      }
    }
  }

  private extractLinkFromTable(i: number, element: any): boolean | void {
    const $element = this.cheerioAPI(element);
    // const titre = $element.find('a').text().trim();
    const href = $element.find('a').attr('href');

    const thumbSrc = $element.find('img').attr('src');
    // console.log('extractLinkFromTable titre:', titre);
    console.log('extractLinkFromTable href:', href);
    console.log('extractLinkFromTable thumbSrc:', thumbSrc);
    console.log('');

    this.manageLinkAdding(href, thumbSrc);
  }

  private extractLink(i: number, element: any): boolean | void {
    const $element = this.cheerioAPI(element);
    // const titre = $element.find('.a-link-normal [data-rows]').text().trim();
    let href = $element.find('.a-link-normal').attr('href');

    if (href && href.startsWith('/s?')) {
      const url = new URL(`${this.websiteExploreHost}${href}`);
      const params = new URLSearchParams(url.search);
      if (!params.get('k').includes(this.targetKeyword)) {
        console.log(`k not includes ${this.targetKeyword} > RETURN\n`);
        return;
      }
      href = `/s?k=${encodeURI(params.get('k'))}`;
    }

    if (
      href &&
      href.startsWith('http') &&
      !href.startsWith(this.websiteExploreHost)
    ) {
      console.log('External link > RETURN\n');
      return;
    }

    const thumbSrc = $element.find('.a-link-normal img').attr('src');

    // const thumbDynamicImage = JSON.parse(
    //   $element.find('.a-link-normal img').attr('data-a-dynamic-image') || '{}',
    // );

    // console.log('extractLink titre:', titre);
    console.log('extractLink href:', href);
    console.log('extractLink thumbSrc:', thumbSrc);
    console.log('');

    this.manageLinkAdding(href, thumbSrc);
  }
}
