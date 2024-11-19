import PQueue from "p-queue"; // Use ES module import
import { createClient } from "@sanity/client"; // Import createClient from Sanity

// Create Sanity client
const config = {
  dataset: process.env.SANITY_STUDIO_API_DATASET,
  projectId: process.env.SANITY_STUDIO_API_PROJECT_ID,
  useCdn: false,
  apiVersion: "2022-11-01",
  token: process.env.SANITY_KEY,
};

const sanityClient = createClient(config);

const queue = new PQueue({
  concurrency: 1,
  interval: 1000 / 25, // Interval for 25 req/s
});

const url = `https://homage.retail.heartland.us/api/inventory/values?group[]=item_id`;
const mutationUrl = `https://${process.env.SANITY_STUDIO_API_PROJECT_ID}.api.sanity.io/v2021-06-07/data/mutate/${process.env.SANITY_STUDIO_API_DATASET}`;

async function main() {
  console.log("Script invoked");

  try {
    let page = 1;
    let totalResults = 0;

    while (true) {
      console.log(`Fetching data for page ${page}...`);
      const response = await fetch(`${url}&page=${page}`, {
        headers: {
          Connection: "close",
          Authorization: `Bearer ${process.env.HEARTLAND_BEARER_TOKEN}`,
        },
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch data for page ${page}: ${response.statusText}`
        );
      }

      const { results: products } = await response.json();

      if (!products || products.length === 0) {
        console.log("No more products found. Exiting loop.");
        break;
      }

      const dataIds = products.map((item) => item.item_id.toString());

      const sanityItemArray = await sanityClient.fetch(
        `
          *[_type in ['product'] && heartlandID in $ids]{
            _id, heartlandID, inventory
          }
        `,
        { ids: dataIds }
      );

      const sanityItemIds = sanityItemArray.map((item) => item.heartlandID);
      const variantIds = dataIds.filter((id) => !sanityItemIds.includes(id));

      let sanityVariantArray = [];

      if (variantIds.length) {
        sanityVariantArray = await sanityClient.fetch(
          `*[_type == 'product' && count((variants[].heartlandID)[@ in $ids]) > 0]{
            variants[heartlandID in $ids]{
              heartlandID,
              _key,
              inventory,
              '_id': ^._id,
            }
          }`,
          { ids: variantIds }
        );
      }

      const flattenedSanityVariantArray = [];

      sanityVariantArray?.forEach((item) => {
        if (item?.variants && item.variants.length > 0) {
          item.variants.forEach((variant) => {
            const flattenedVariant = {
              heartlandID: variant.heartlandID,
              _key: variant._key,
              inventory: variant.inventory,
              _id: variant._id,
            };

            flattenedSanityVariantArray.push(flattenedVariant);
          });
        }
      });

      const combinedArray = sanityItemArray.concat(flattenedSanityVariantArray);

      const updatedInventory = products
        .map((item) => {
          if (item.qty_available === null) {
            return null; // Skip this item
          }

          const product = combinedArray.find(
            (product) => product.heartlandID === item.item_id.toString()
          );

          if (product) {
            if (product.inventory === item.qty_available) {
              return null;
            }

            const inventoryValue = item.qty_available;

            console.log(`Processing item with item_id ${item.item_id}`);

            if ("_key" in product) {
              return {
                patch: {
                  id: product._id,
                  set: {
                    [`variants[_key == "${product._key}"].inventory`]:
                      inventoryValue,
                  },
                },
              };
            } else {
              return {
                patch: {
                  id: product._id,
                  set: {
                    inventory: inventoryValue,
                  },
                },
              };
            }
          }
        })
        .filter((valid) => valid !== null && valid !== undefined);

      totalResults += updatedInventory.length;

      updatedInventory.forEach((item) => {
        queue.add(() => updateSanityInventory(item));
      });

      console.log(`Page ${page} processed. Moving to the next page.`);
      page++;
    }

    await queue.onIdle(); // Wait for the queue to finish

    console.log(`Total products fetched and added: ${totalResults}`);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1); // Exit with failure
  }
}

async function updateSanityInventory(item) {
  try {
    const mutationsRes = await fetch(mutationUrl, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.SANITY_KEY}`,
      },
      body: JSON.stringify({ mutations: [item] }),
      method: "POST",
    });
    if (!mutationsRes.ok) {
      console.log(mutationsRes.status);
      throw new Error(`${mutationsRes.status} - ${mutationsRes.statusText}`);
    }
  } catch (error) {
    console.error("Error updating Sanity document:", error.message);
    // Optionally, handle retries or logging for failed updates
  }
}

// Execute the script
main();
